#!/usr/bin/env node
/* G-scope's SELECT card: one selection model, five ways in (docs/GSCOPE-SELECT.md).

   Modes, a row of five: Piece . Region . Feature . Line . Layer. In EVERY mode
   the same three things, whatever the thing is:
     hover   outlines what a click would take
     click   isolates it; click it again, or Escape, and it is whole again
     drag    pulls it onto TAKE (ticket 1's gesture) - LENS untouched
   and a press on bare plate orbits in every mode.

   The legend is the FEATURES list: the slicer's line types only, Bambu-style -
   swatch, name, count, a checkbox - and CHECKBOXES ONLY (docs/GSCOPE.md, item
   4): shown is the union of the checked rows, the text toggles its box, hover
   does nothing, and what is shown is what Select, a drag and Export act on.
   Surface features (flange, handle ...) and Lift's Features readout are gone
   from G-scope: they live on the plate.

   Every drive is a real mouse.

   GATES
     1. The card: the five modes in a row, none of the old Orbit / Pick a line /
        Select layer buttons, no LINE / LAYER column buttons, the old ids that
        stay on the new controls; Feature / Line / Layer are a slice's. The
        column is IMPORT . READ PLATE | SELECT . VIEW.
     1b. The hover's clock (one hover per 40 ms), on a fake clock: the last
        move is always answered, and never an older one after it.
     2. Each mode isolates: hover outlines, click isolates (the rest out of the
        view), click again un-isolates, Escape un-isolates.
     3. Each mode pulls: a press on the hovered thing and a drag lands exactly
        that thing on TAKE, and LENS is byte-identical afterwards.
     4. The slider's range is one card: hover, click, drag - one piece.
     5. The Features list, checkboxes only: hover changes nothing; the row text
        toggles its box and nothing else; a row is not dragged; two rows
        checked - exactly those two line types drawn; none - nothing; checked
        again, type by type; Check all checks every box; what is shown is what
        Export and a drag take; the boxes are one set for both plates.
     6. A mode switch keeps the camera; a press on bare plate orbits in every
        mode; Line's arrows and Layer's steps; the Escape ladder.
     7. A plate piece (mesh): Piece and Region only, the list says "not sliced".
     8. What left: detector rows, the Features readout, the old controls.
     9. A big piece (400,000 triangles) whose search tree (nso_bvh.js) is still
        building: Piece and Region hover report anyway - its box answers
        until the tree is ready.

   Every hover is waited for (waitHover: up to 2 s, then a failure that says
   how long it waited), never read once after a fixed pause.

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
      pxOf: pxOf,
      pxObject: () => { const d = M().getDoc(), o = d.objects[0], b = o.bounds; return pxOf((b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2, b.maxZ); },
      /* a point on plate 2's bed (its own Z-up mm), whichever plate is active (docs/GSCOPE.md) */
      bedPx: (x, y) => toPx(new THREE.Vector3(M().plateOffset('take') + x, 0, -y)),
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
  window.__dl = [];
  window.downloadBlob = function (blob, name) { window.__dl.push({ name: name, size: blob.size }); };
`;
const evalT = (page, fn, arg) => page.evaluate(fn, arg);
const plate = page => page.evaluate(() => NSO_MICROSCOPE.plate());

/* The hover, waited for. A hover is drawn on G-scope's own clock - at most one
   every 40 ms, the last move of a burst on a timer when the 40 ms are up - and
   behind the box's frames, so a fixed wait races it. Polled until it answers, up to `ms` (2 s): { info, kids,
   cursor, ms }, `info` null if nothing came in time - never read off a null. */
async function waitHover(page, ms) {
  const limit = ms || 2000, t0 = Date.now();
  for (;;) {
    const h = await page.evaluate(() => ({ info: NSO_MICROSCOPE.hoverInfo(), kids: NSO_MICROSCOPE.getView().hoverGroup.children.length,
                                           cursor: NSO_MICROSCOPE.getView().renderer.domElement.style.cursor }));
    const el = Date.now() - t0;
    if (h.info || el >= limit) return Object.assign(h, { ms: el });
    await page.waitForTimeout(20);
  }
}
const hoverSays = h => h.info ? J(h.info) + ' - after ' + h.ms + ' ms' : 'no hover after ' + h.ms + ' ms';
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
/* The plates stand side by side and a click on one makes it active (docs/GSCOPE.md); these checks are
   about the Select card, so the plate is made active through the engine's own call. */
const activate = async (page, n) => { await page.evaluate(n => NSO_MICROSCOPE.showPlate(n), n); await frames(page); };
async function showLens(page) { if (await plate(page) !== 'lens') await activate(page, 'lens'); }
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

  /* plate 2's bed pixels are read once: the opening view is the same for every pull */
  const dest = [];
  for (const [x, y] of [[-30, -25], [-12, -25], [6, -25], [24, -25], [-30, 0], [-12, 0], [6, 0], [24, 0]]) dest.push(await page.evaluate(([x, y]) => window.__t.bedPx(x, y), [x, y]));

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
    check('the column is Import, Read plate | Select, View', J(r.column) === J(['ms-btn-open', 'ms-btn-plate', 'ms-nav-select', 'ms-nav-view']), J(r.column));
    check('Piece is the mode a document opens in; on a slice every mode is available', r.mode === 'piece' && r.avail.every(Boolean) && J(r.pressed) === J(['true', 'false', 'false', 'false', 'false']), J(r.pressed));
    await page.click('#ms-nav-select'); await frames(page);
    await shot('01-select-card');
    await cards.closeCards(page);
  }

  /* ------------------------------------------------------------------ 1b */
  console.log('\n=== 1b. the hover\'s clock: the last move is always answered, never an older one ===');
  {
    // G-scope hovers at most once per 40 ms. Driven here on a FAKE clock (performance.now,
    // Date.now and setTimeout swapped for the drive), so these are exact times, not this box's:
    //   a. moves at 0, 10, 34 ms off the piece, then the last one ON it at 65 ms - it
    //      must be outlined (a stale timer used to take that move and drop it);
    //   b. a move off it at 0, ON it at 38 ms, off it again at 41 ms - nothing may be
    //      outlined (a stale timer used to paint the 38 ms move after the 41 ms one).
    await showLens(page);
    await page.evaluate(() => { const M = NSO_MICROSCOPE; M.clearBoxes(); M.checkAll(); M.setFeatureDisplay('Travel', false); if (M.isIsolated()) M.back();
      M.setSelectionMoves([]); M.normalView(); M.setMode('piece'); });
    await frames(page);
    const runSeq = (seq) => page.evaluate((seq) => {
      const M = NSO_MICROSCOPE, v = M.getView(), c = v.renderer.domElement, d = M.getDoc(), r = c.getBoundingClientRect();
      const s = d.segments.find(g => g.feature === 'Outer wall' && g.layer === 1);
      const p = new THREE.Vector3((s.x0 + s.x1) / 2 - d.cx, s.z, -((s.y0 + s.y1) / 2 - d.cy)).project(v.camera);
      const at = { on: [r.left + (p.x + 1) / 2 * r.width, r.top + (1 - p.y) / 2 * r.height], off: [r.left + 30, r.top + 30] };
      const realNow = performance.now, realDate = Date.now, realSet = window.setTimeout, q = [];
      // each drive starts well past the last hover any earlier drive (or either real clock) stamped
      let now = Math.max(window.__fakeHoverT || 0, realNow.call(performance), realDate.call(Date)) + 1e5;
      const t0 = now;
      performance.now = () => now;
      Date.now = () => now;
      window.setTimeout = (fn, ms) => { q.push({ at: now + (ms || 0), fn }); return q.length; };
      const runTo = (t) => { for (;;) { q.sort((a, b) => a.at - b.at); const j = q[0]; if (!j || j.at > t) break; q.shift(); now = j.at; j.fn(); } now = t; };
      try {
        seq.forEach(([ms, where]) => {
          runTo(t0 + ms);
          c.dispatchEvent(new PointerEvent('pointermove', { clientX: at[where][0] + (ms % 7), clientY: at[where][1], bubbles: true, buttons: 0 }));
        });
        runTo(t0 + 1000);
        const h = M.hoverInfo();
        return { info: h, left: q.length };
      } finally { window.__fakeHoverT = now; performance.now = realNow; Date.now = realDate; window.setTimeout = realSet; }
    }, seq);
    const a = await runSeq([[0, 'off'], [10, 'off'], [34, 'off'], [65, 'on']]);
    check('a. the last move (onto the piece, 65 ms after a burst) is answered: the piece is outlined, no timer left', !!a.info && a.info.source === 'pick' && a.left === 0, J(a));
    await page.mouse.move(5, 5);
    const b = await runSeq([[0, 'off'], [38, 'on'], [41, 'off']]);
    check('b. an older move is never answered after a newer one: off the piece at 41 ms, nothing outlined, no timer left', !b.info && b.left === 0, J(b));
    await page.mouse.move(5, 5);
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
    await page.evaluate(() => { const M = NSO_MICROSCOPE; M.clearBoxes(); M.checkAll(); M.setFeatureDisplay('Travel', false); if (M.isIsolated()) M.back(); M.normalView(); });
    await setMode(page, id);
    const want = await page.evaluate(([f, l]) => window.__t.countWhere(f, l), [feat, layer]);
    let px = await page.evaluate(([f, l]) => window.__t.pxSeg(f, l), [feat, layer]);
    // hover
    await page.mouse.move(px[0] - 40, px[1] - 40);
    await page.mouse.move(px[0], px[1], { steps: 3 });
    await page.waitForTimeout(160);
    const hv = await waitHover(page);
    const n = expect(want);
    check(label + ': hover outlines what a click would take (' + (n == null ? 'the box region' : n + ' move(s)') + ')', !!hv.info && hv.info.source === source && hv.kids > 0 && hv.cursor === 'pointer' && (n == null ? hv.info.count > 0 : hv.info.count === n), hoverSays(hv));
    if (id === 'piece') await shot('02-hover-piece');
    const hoverCount = hv.info ? hv.info.count : -1;
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
    const hv2 = (await waitHover(page)).info;
    await drag(page, px, dest[pulled % dest.length]);
    const after = await page.evaluate(() => ({ plate: NSO_MICROSCOPE.plate(), pieces: window.__t.pieces() }));
    const piece = after.pieces[after.pieces.length - 1];
    check(label + ': a drag pulls it onto TAKE - one new piece with exactly the hovered ' + (hv2 ? hv2.count : '?') + ' move(s)', after.plate === 'take' && after.pieces.length === n0 + 1 && hv2 && piece.moves === hv2.count, J([after.plate, after.pieces.length, piece && piece.moves, hv2 && hv2.count, piece && piece.name]));
    await activate(page, 'lens');
    check(label + ': LENS is byte-identical after the pull', await lensState(page) === before);
    pulled++;
  }
  await shot('04-after-five-pulls');

  /* ------------------------------------------------------------------ 4 */
  console.log('\n=== 4. the slider\'s range is one card ===');
  {
    await showLens(page);
    await page.evaluate(() => { const M = NSO_MICROSCOPE; M.clearBoxes(); M.checkAll(); M.setFeatureDisplay('Travel', false); if (M.isIsolated()) M.back(); M.setMode('layer'); M.setZRange(0, 1); M.flushView(); });
    await frames(page);
    const want = await page.evaluate(() => NSO_MICROSCOPE.shownCount());
    const full = await page.evaluate(() => NSO_MICROSCOPE.getDoc().segments.length);
    const card = await page.evaluate(() => { const b = document.getElementById('ms-zr-card').getBoundingClientRect(); return [b.left + b.width / 2, b.top + b.height / 2, b.width > 0]; });
    check('the slider has a Range card, and the range (two handles) narrows what is shown', card[2] && want > 0 && want < full, want + ' of ' + full + ' moves');
    await page.mouse.move(card[0], card[1]);
    await page.waitForTimeout(160);
    const hv = await waitHover(page);
    check('hovering the card outlines the whole range', !!hv.info && hv.info.source === 'range' && hv.info.count === want && hv.kids > 0, hoverSays(hv));
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
    await activate(page, 'lens');
    check('LENS is byte-identical after it', await lensState(page) === before);
    await page.evaluate(() => NSO_MICROSCOPE.setZRange(0, 1e6)); await frames(page);
    check('the slider\'s range also works on a slice: All gives the whole range back', await page.evaluate(() => NSO_MICROSCOPE.shownCount()) === full);
    await shot('05-range');
  }

  /* ------------------------------------------------------------------ 5 */
  console.log('\n=== 5. the Features list: checkboxes only ===');
  {
    await showLens(page);
    await page.evaluate(() => { const M = NSO_MICROSCOPE; M.clearBoxes(); M.setSelectionMoves([]); if (M.isIsolated()) M.back(); });
    await frames(page);
    const rows = await page.evaluate(() => Array.from(document.querySelectorAll('#ms-legend .ms-legend-item')).map(r => {
      const lab = r.querySelector('.ms-legend-label'), cb = r.querySelector('input.ms-legend-display');
      return { name: r.dataset.group, label: lab.textContent, swatch: !!r.querySelector('.ms-swatch'), check: !!cb,
               labelFor: lab.tagName === 'LABEL' && lab.htmlFor === cb.id, sw: r.querySelector('.ms-swatch').style.background };
    }));
    const title = await page.evaluate(() => document.getElementById('ms-legend-title').textContent);
    check('the list is titled Features and holds the slice\'s line types, Bambu order: swatch, name (count), checkbox - the text is the box\'s label',
      title === 'Features' && J(rows.map(r => r.name)) === J(['Outer wall', 'Inner wall', 'Sparse infill', 'Support', 'Support interface']) &&
      rows.every(r => r.swatch && r.check && r.labelFor && /\(\d+\)$/.test(r.label) && r.sw), J(rows.map(r => r.label)));
    check('no detector rows, no Parts', await page.evaluate(() => !document.getElementById('ms-detected') && !document.querySelector('.ms-detected-item')));
    const NAMES = rows.map(r => r.name);
    /* what is drawn, per line type: the overview meshes that are visible and hold lines */
    const drawnTypes = () => page.evaluate(() => { const v = NSO_MICROSCOPE.getView();
      return Object.keys(v.overviewMeshes).filter(k => { const m = v.overviewMeshes[k]; return m.visible && m.geometry.attributes.position.count > 0; }).sort(); });
    const box = name => '#ms-legend .ms-legend-item[data-group="' + name + '"] .ms-legend-display';
    const lbl = name => '#ms-legend .ms-legend-item[data-group="' + name + '"] .ms-legend-label';

    // hover does nothing
    const s0 = await lensState(page);
    const lp = await page.evaluate(sel => { const b = document.querySelector(sel).getBoundingClientRect(); return [b.left + b.width / 2, b.top + b.height / 2]; }, lbl('Outer wall'));
    await page.mouse.move(lp[0], lp[1]);
    await page.waitForTimeout(200);
    const hv = await waitHover(page);       // the whole 2 s: an outline that came late would be caught
    check('hovering a row changes nothing: no outline, nothing on the plate changes', !hv.info && hv.kids === 0 && await lensState(page) === s0, hoverSays(hv));

    // a click on the row text toggles its box, and nothing else
    await page.click(lbl('Support'));
    await frames(page);
    const t1 = await page.evaluate(sel => ({ checked: document.querySelector(sel).checked, off: NSO_MICROSCOPE.hidden(), iso: NSO_MICROSCOPE.isIsolated(),
      sel: NSO_MICROSCOPE.selection().length, mode: NSO_MICROSCOPE.mode(), n: window.__t.pieces().length }), box('Support'));
    check('a click on the row text toggles its box: Support unchecked - and nothing isolated, selected or moved', !t1.checked && t1.off.indexOf('Support') >= 0 && !t1.iso && t1.sel === 0, J(t1));
    check('...the Support lines are not drawn', (await drawnTypes()).indexOf('Support') < 0, J(await drawnTypes()));
    await page.click(lbl('Support'));
    await frames(page);
    check('the text again: checked, drawn again', await page.evaluate(sel => document.querySelector(sel).checked, box('Support')) && (await drawnTypes()).indexOf('Support') >= 0);
    // a drag from a row pulls nothing (rows are not cards any more)
    const n0 = await page.evaluate(() => window.__t.pieces().length);
    await drag(page, lp, dest[6]);
    check('a drag from a row copies nothing and isolates nothing', await page.evaluate(() => window.__t.pieces().length) === n0 && !(await iso(page)) && await plate(page) === 'lens');

    // check two rows -> exactly those two line types visible
    for (const n of NAMES) if (n !== 'Outer wall' && n !== 'Support') await page.click(box(n));
    await frames(page);
    const two = await drawnTypes();
    const twoShown = await page.evaluate(() => [...new Set(NSO_MICROSCOPE.selectVisible().map(s => s.feature))].sort());
    check('two rows checked: exactly those two line types are drawn', J(two) === J(['Outer wall', 'Support']), J(two));
    check('...and Select shown takes exactly those two', J(twoShown) === J(['Outer wall', 'Support']), J(twoShown));
    await shot('06-two-checked');
    await page.evaluate(() => NSO_MICROSCOPE.setSelectionMoves([]));
    // uncheck all -> nothing
    await page.click(box('Outer wall'));
    await page.click(box('Support'));
    await frames(page);
    const none = { drawn: await drawnTypes(), count: await page.evaluate(() => NSO_MICROSCOPE.shownCount()), sel: await page.evaluate(() => NSO_MICROSCOPE.selectVisible().length) };
    check('every box unchecked: nothing is drawn, nothing is shown, Select shown takes nothing', none.drawn.length === 0 && none.count === 0 && none.sel === 0, J(none));
    const px0 = await page.evaluate(() => window.__t.pxSeg('Outer wall', 1));
    check('...and a press where a line was has nothing to take', !(await page.evaluate(p => NSO_MICROSCOPE.pressTargetAt(p[0], p[1]), px0)));
    await shot('06-none-checked');
    // re-checking rebuilds feature by feature
    await page.click(box('Inner wall'));
    await frames(page);
    const r1 = await drawnTypes();
    await page.click(lbl('Sparse infill'));
    await frames(page);
    const r2 = await drawnTypes();
    check('re-checking rebuilds feature by feature: Inner wall, then Inner wall + Sparse infill', J(r1) === J(['Inner wall']) && J(r2) === J(['Inner wall', 'Sparse infill']), J([r1, r2]));
    // Check all: every box
    await page.click('#ms-nav-view');
    await page.click('#ms-btn-show-all');
    await frames(page);
    await cards.closeCards(page);
    const all = await page.evaluate(() => ({ checks: Array.from(document.querySelectorAll('#ms-legend .ms-legend-display')).map(c => c.checked), off: NSO_MICROSCOPE.hidden(),
      label: document.getElementById('ms-btn-show-all').textContent.trim() }));
    check('Check all (same id as Show all) checks every box - the whole piece', all.label === 'Check all' && all.checks.every(Boolean) && all.off.length === 0 && J(await drawnTypes()) === J(NAMES.slice().sort()), J(all));

    // whatever is shown is what Select / drag / export act on
    await page.evaluate(() => { const M = NSO_MICROSCOPE; M.setMode('layer'); M.selectLayer(1); });
    const lay = await page.evaluate(() => ({ n: NSO_MICROSCOPE.selection().length, sup: NSO_MICROSCOPE.selection().filter(s => s.feature === 'Support').length }));
    await page.click(box('Support'));
    await frames(page);
    await page.evaluate(() => { window.__dl.length = 0; });
    await page.click('#ms-nav-export');
    await page.click('#ms-btn-export-stl');
    await cards.closeCards(page);
    const dl = await page.evaluate(() => window.__dl.map(d => d.size));
    check('a layer selected, Support unchecked: Export writes only what is shown (12 triangles a shown move)',
      lay.sup > 0 && dl.length === 1 && dl[0] === 84 + (lay.n - lay.sup) * 12 * 50, J([lay, dl]));
    const before = await lensState(page);
    const from = await page.evaluate(() => window.__t.pxSeg('Outer wall', 1));
    await page.evaluate(() => NSO_MICROSCOPE.isolate());
    await frames(page);
    const fromIso = await page.evaluate(() => { const M = NSO_MICROSCOPE, d = M.getDoc(), s = M.selection().find(g => g.feature === 'Outer wall'), v = M.getView();
      const p = new THREE.Vector3((s.x0 + s.x1) / 2 - d.cx, s.z, -((s.y0 + s.y1) / 2 - d.cy)).project(v.camera); const r = v.renderer.domElement.getBoundingClientRect();
      return [r.left + (p.x + 1) / 2 * r.width, r.top + (1 - p.y) / 2 * r.height]; });
    const destNow = await page.evaluate(() => window.__t.bedPx(20, 20));
    await drag(page, fromIso, destNow);
    const pulled = await page.evaluate(() => window.__t.pieces().slice(-1)[0]);
    check('...and a drag copies only what is shown onto plate 2', pulled && pulled.moves === lay.n - lay.sup, J([pulled && pulled.moves, lay.n - lay.sup, from]));
    await activate(page, 'lens');
    // Display acts on both plates
    await activate(page, 'take');
    const tk = await page.evaluate(() => ({ dim: !!document.querySelector('#ms-legend .ms-legend-item[data-group="Support"] input:not(:checked)'), off: NSO_MICROSCOPE.plateState('take').featuresOff }));
    check('plate 2 reads the same boxes: Support is unchecked there too', tk.dim && tk.off.indexOf('Support') >= 0, J(tk));
    await page.click(box('Support'));
    await activate(page, 'lens');
    check('...checked on plate 2, it is checked on plate 1 too', await page.evaluate(sel => document.querySelector(sel).checked, box('Support')));
    await page.evaluate(() => { const M = NSO_MICROSCOPE; if (M.isIsolated()) M.back(); M.selectLayer(0); M.setSelectionMoves([]); M.setFeatureDisplay('Travel', false); M.setMode('piece'); });
    check('plate 1 was never changed by any of it', JSON.parse(await lensState(page)).sum === JSON.parse(before).sum);
  }

  /* ------------------------------------------------------------------ 6 */
  console.log('\n=== 6. the camera, the orbit, the arrows, the Escape ladder ===');
  {
    await showLens(page);
    await page.evaluate(() => { const M = NSO_MICROSCOPE; M.clearBoxes(); M.checkAll(); M.setFeatureDisplay('Travel', false); M.setSelectionMoves([]); if (M.isIsolated()) M.back(); M.normalView(); });
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
    const hv = await waitHover(page);
    check('Piece: hover outlines the piece', !!hv.info && hv.info.source === 'pick' && hv.info.count === 1 && hv.kids > 0, hoverSays(hv));
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
    await activate(page, 'lens');
    check('LENS is byte-identical after it', await lensState(page) === before);
    // Region on a mesh
    await setMode(page, 'select');
    await page.evaluate(() => NSO_MICROSCOPE.normalView()); await frames(page);
    const px3 = await page.evaluate(() => window.__t.pxObject());
    await page.mouse.move(px3[0], px3[1]); await page.waitForTimeout(160);
    const hv3 = (await waitHover(page)).info;
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

  /* ------------------------------------------------------------------ 9 */
  console.log('\n=== 9. a big piece, its tree still building: the hover reports anyway ===');
  {
    for (const [m, source] of [['piece', 'pick'], ['select', 'box']]) {
      // the pointer off the canvas first, onto one of G-scope's own buttons (the canvas
      // fills the window, so a corner is still the canvas): a move still waiting for its
      // hover is dropped there, not answered over the new sheet - that ray would ask
      // nso_bvh.js for the sheet's tree before the check does
      const off = await page.evaluate(() => { const c = NSO_MICROSCOPE.getView().renderer.domElement;
        for (const id of ['ms-btn-frame', 'ms-close', 'ms-btn-open', 'ms-hint-badge']) {
          const el = document.getElementById(id), b = el && el.getBoundingClientRect();
          if (!b || !b.width || !b.height) continue;
          const x = b.left + b.width / 2, y = b.top + b.height / 2, hit = document.elementFromPoint(x, y);
          if (hit && hit !== c && !c.contains(hit)) return { at: [x, y], id };
        }
        return null; });
      if (off) await page.mouse.move(off.at[0], off.at[1]);
      await page.waitForTimeout(80);
      // a fresh sheet for each mode: a new geometry, so no tree for it yet
      // a flat 20 mm sheet of 400,000 triangles: big enough that nso_bvh.js's hover
      // rule answers nothing until its tree is built (in a worker, after the first ask)
      await page.evaluate(() => {
        const n = 448, side = 20, p = new Float32Array(n * n * 2 * 9);
        let w = 0;
        for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
            const x0 = i * side / n, x1 = (i + 1) * side / n, y0 = j * side / n, y1 = (j + 1) * side / n;
            p.set([x0, y0, 1, x1, y0, 1, x1, y1, 1, x0, y0, 1, x1, y1, 1, x0, y1, 1], w); w += 18;
        }
        NSO_MICROSCOPE.openObjects('Sheet', [{ name: 'Sheet', positions: p }], { source: 'objects' });
        NSO_MICROSCOPE.normalView();
      });
      await frames(page);
      await page.evaluate(m => NSO_MICROSCOPE.setMode(m), m);
      const at = await page.evaluate(() => { const M = NSO_MICROSCOPE, d = M.getDoc(), b = d.objects[0].bounds;
        return window.__t.pxOf ? window.__t.pxOf((b.minX + b.maxX) / 2 + 2, (b.minY + b.maxY) / 2 + 1, b.maxZ) : null; });
      const tree0 = await page.evaluate(() => { const m = NSO_MICROSCOPE.getView().overviewMeshes.Sheet; return !!NSO_BVH.peek(m.geometry.attributes.position.array); });
      // ONE move, from the button straight onto the sheet: the first ray over the canvas
      // since the sheet opened, answered at once (the last hover is long past) - so the
      // tree is first asked for by this very ray, and cannot be there to answer it
      await page.mouse.move(at[0], at[1]);
      const hv = await waitHover(page);
      const tree1 = await page.evaluate(() => { const m = NSO_MICROSCOPE.getView().overviewMeshes.Sheet; return !!NSO_BVH.peek(m.geometry.attributes.position.array); });
      check((m === 'piece' ? 'Piece' : 'Region') + ': hover over the big piece reports while its tree is still building (none when the pointer came) - its box answered',
        !!off && !tree0 && !!hv.info && hv.info.source === source && hv.info.count >= 1 && hv.info.stand === 'box',
        hoverSays(hv) + '; pointer off the canvas on #' + (off ? off.id : '(no button found)') + '; tree before / after: ' + tree0 + ' / ' + tree1);
      await page.mouse.move(at[0] - 200, at[1] - 200);
    }
  }

  const errs = logs.filter(l => /^\[pageerror\]/.test(l) || /^\[error\]/.test(l)).filter(l => !/Failed to load resource/.test(l));
  check('no page errors', errs.length === 0, errs.slice(0, 3).join(' | ') || 'none');
  console.log(fails ? '\n' + fails + ' FAILED' : '\nall gates held');
  process.exit(fails ? 1 : 0);
}).catch(e => { console.error('TEST CRASH', e); process.exit(1); });
