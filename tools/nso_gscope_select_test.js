#!/usr/bin/env node
/* G-scope's selecting, round 2c: ONE card (docs/GSCOPE.md item 12).

   The left column (IMPORT . READ PLATE | SELECT . VIEW) and the SELECT and
   VIEW cards are gone. In their place one permanent card, top-left:
     IMPORT ▾ (Read plate in the ▾) . the Normal | Slice switch
     the rows for the switch's side - Normal: REGION . WHOLE PART;
     Slice: REGION . TAKE BAND . Toolpath | Solid . Slice settings (folded)
   The side is the document's: a toolpath is the Slice side.

   The view's own gesture is the PIECE:
     hover   outlines what a click would take
     click   isolates it; click it again, or Escape, and it is whole again
     drag    pulls it onto TAKE (ticket 1's gesture) - LENS untouched
   and a press on bare plate orbits. REGION (item 7) arms the capture box: a
   click PLACES a box and isolates nothing; its dots size it; a click inside
   it, or Isolate, isolates what the boxes hold; Escape removes a box that is
   not isolated. The dots (item 8) are drawn on top and own the left press in
   every mode, even with the piece in front of them.

   What the old SELECT modes did lives on at its new home:
     Feature  the Features list (what is checked is what a click / drag takes)
     Line     the hover readout (SELECTION / SEGMENT INFO says "Move N ...");
              isolating one move from the UI is dropped (pickLine API stays)
     Layer    the slider + TAKE BAND (and the selectLayer API)

   The legend is the FEATURES list: the slicer's line types only, Bambu-style -
   swatch, name, count, a checkbox - and CHECKBOXES ONLY (docs/GSCOPE.md, item
   4): shown is the union of the checked rows, the text toggles its box, hover
   does nothing, and what is shown is what a click, a drag and Export act on.
   Check all is in its head.

   Every drive is a real mouse (a real wheel zooms in on a box), or the
   keyboard where a key is the control: Escape, the arrows, the slider's handles.

   GATES
     1. The card: the column, SELECT and VIEW are gone (and every old id with
        them); one permanent card top-left - IMPORT where the main page's
        Import is, its ▾ menu holding Read plate (Escape or a press outside
        shuts it); the switch Normal . track . Slice on the document's side
        (an imported slice: Slice, Normal off); the Slice side shows exactly 4
        rows; REGION is a toggle; Slice settings folded at the printer
        profile's 0.4 / 0.2; the modes are piece and select only.
     1b. The hover's clock (one hover per 40 ms), on a fake clock: the last
        move is always answered, and never an older one after it.
     2. Isolate: Piece (a view click) and Feature (the Features list, then the
        view click) - hover outlines, click isolates, click again / Escape
        un-isolates. Line: hovering a move reads "Move N ..." out in
        SELECTION / SEGMENT INFO, leaving it puts the old text back, a click
        isolates the piece (not one move). Layer: the slider narrowed to one
        layer + Take band isolates exactly that layer; mode untouched.
        REGION (item 7) on the 51-move slice: click places a box, nothing
        isolated (selection = box contents); a corner-dot drag resizes it,
        still nothing isolated; a second click adds a box (union); a click
        inside (away from the dots) isolates exactly what the boxes hold;
        again, whole; Isolate the same; Escape un-isolates, then removes the
        last box; Clear boxes; a sparse spot (no move midpoint in the box)
        still hovers and places an (empty) box.
     3. Each way pulls: a drag lands exactly that thing on TAKE (Piece, the
        Features list's shown moves, a REGION hover, a picked line via the
        API - its only home now - and the band), and LENS is byte-identical.
     4. The slider's range is one card: hover, click, drag - one piece.
     5. The Features list, checkboxes only: hover changes nothing; the row text
        toggles its box and nothing else; a row is not dragged; two rows
        checked - exactly those two line types drawn, and a view click takes
        exactly them (Select shown's button is gone; selection is what is
        shown); none - nothing; checked again, type by type; Check all (in
        the list's head) checks every box; what is shown is what Export and a
        drag take; the boxes are one set for both plates.
     6. REGION on / off keeps the camera; a press on bare plate orbits armed
        or not; the arrows step a picked line (the API's - only with
        selectionSource 'line'); the slider's handles step the band, Take
        band takes it; the Escape ladder: the ▾ menu, then Export, shut ->
        isolated -> whole -> the box goes -> REGION disarms -> G-scope closes
        (and opens again on the imported slice, a fresh visit).
     7. A plate piece (mesh), read through IMPORT ▾ -> Read plate into the
        active plate: the Normal side (exactly 2 rows), the list says "not
        sliced", Piece and Region only; Piece isolates, WHOLE PART backs
        out, a drag pulls; REGION's item-7 gates on the mesh piece; item 8:
        a dot BEHIND the piece (a raycast proves the piece is in front) takes
        a real left press - a handle drag that moves the box, no pull, the
        piece not selected - with REGION armed and disarmed; a click on a dot
        isolates nothing; a right drag on a dot pans; the dots are drawn on
        top and never under 6 px.
     8. What left: detector rows, the Features readout, the old controls;
        Clear from view / Select shown are API only; the corner CLEAR empties
        the active plate.
     9. A big piece (400,000 triangles) whose search tree (nso_bvh.js) is still
        building: Piece and Region hover report anyway - its box answers
        until the tree is ready.
    10. An NSO slice of a piece and the supports the card built for it (the
        clip coupon, slicer:supports): the switch slices (the Slice side, 4
        rows, Normal on: a slice made here), the Features list carries
        Support, Support interface and Support transition, no wall or infill
        row comes from a support, the readout credits the host, and the
        checkboxes + the view click treat the new rows as any other.

   Every hover is waited for (waitHover: up to 120 animation frames, then a
   failure that says how long it waited), never read once after a fixed pause.

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
const CLIP = path.join(ROOT, 'fixtures', 'supports', 'top_clip_x2.stl');   // slicer:supports' coupon
const J = JSON.stringify;
const frames = page => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));

/* Every id the round-2c card took away (docs/GSCOPE.md item 12), and the older ones before them. */
const GONE = ['ms-sidebar', 'ms-card-select', 'ms-card-view', 'ms-nav-select', 'ms-nav-view',
  'ms-mode-piece', 'ms-mode-feature', 'ms-mode-line', 'ms-mode-layer', 'ms-mode-row', 'ms-mode-note',
  'ms-select-controls', 'ms-line-controls', 'ms-line-prev', 'ms-line-next', 'ms-line-read', 'ms-btn-isolate-line',
  'ms-layer-row', 'ms-layer-prev', 'ms-layer-index', 'ms-layer-next', 'ms-btn-layer-select', 'ms-layer-note',
  'ms-detail-controls', 'ms-visibility-row', 'ms-btn-clear-view', 'ms-btn-select-visible',
  'ms-mode-orbit', 'ms-nav-line', 'ms-nav-layer', 'ms-card-line', 'ms-card-layer'];

const PAGE_HELPERS = `
  window.__t = (function () {
    const M = () => window.NSO_MICROSCOPE;
    const rect = () => M().getView().renderer.domElement.getBoundingClientRect();
    const toPx = (v) => { const p = v.clone().project(M().getView().camera), r = rect(); return [r.left + (p.x + 1) / 2 * r.width, r.top + (1 - p.y) / 2 * r.height]; };
    const pxOf = (x, y, z) => { const d = M().getDoc(); return toPx(new THREE.Vector3(x - d.cx, z, -(y - d.cy))); };
    const find = (feature, layer) => M().getDoc().segments.find(g => g.feature === feature && g.layer === layer);
    const shown = () => { const off = M().hidden(); return M().getDoc().segments.filter(g => off.indexOf(g.feature) < 0); };
    // the capture predicate (docs/GCODE-MICROSCOPE.md), the test's own: a move's midpoint inside a
    // box's turned footprint and within its height; a mesh piece whose bounds meet the box
    const inBox = (b, x, y, z) => { if (Math.abs(z - b.gz) > b.h) return false; const dx = x - b.gx, dy = y - b.gy;
      return Math.abs(dx * b.ca + dy * b.sa) <= b.rx && Math.abs(-dx * b.sa + dy * b.ca) <= b.ry; };
    const ids = a => a.slice().sort((p, q) => typeof p === 'number' ? p - q : String(p) < String(q) ? -1 : 1);
    return {
      state: n => JSON.stringify(M().plateState(n)),
      pxSeg: (feature, layer) => { const s = find(feature, layer); return pxOf((s.x0 + s.x1) / 2, (s.y0 + s.y1) / 2, s.z); },
      pxMove: (index, t) => { const s = M().getDoc().segments.find(g => g.mv.index === index); t = t == null ? 0.5 : t;
        return pxOf(s.x0 + (s.x1 - s.x0) * t, s.y0 + (s.y1 - s.y0) * t, s.z); },
      segOf: (feature, layer) => { const s = find(feature, layer); return { index: s.mv.index, zi: s.zi, obj: s.obj }; },
      countWhere: (feature, layer) => { const s = find(feature, layer), sh = shown();
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
      target: () => JSON.stringify(M().getView().controls.target.toArray().map(v => +v.toFixed(4))),
      pieces: () => M().takePieces(),
      /* screen px per mm at a point of the open document */
      mmPx: (x, y, z) => { const a = pxOf(x, y, z), b = pxOf(x + 1, y, z), c = pxOf(x, y + 1, z);
        return (Math.hypot(b[0] - a[0], b[1] - a[1]) + Math.hypot(c[0] - a[0], c[1] - a[1])) / 2; },
      /* the selection as ids: a move's index, a piece's name */
      selIds: () => ids(M().selection().map(s => s.mv ? s.mv.index : s.name)),
      /* what the capture boxes hold, by the test's own predicate */
      boxHolds: () => { const d = M().getDoc(), bs = M().boxes();
        if (d.kind === 'toolpath') return ids(shown().filter(s => bs.some(b => inBox(b, (s.x0 + s.x1) / 2, (s.y0 + s.y1) / 2, s.z))).map(s => s.mv.index));
        return ids(d.objects.filter(o => M().hidden().indexOf(o.name) < 0 && bs.some(b => o.bounds.minX <= b.gx + b.ex && o.bounds.maxX >= b.gx - b.ex &&
          o.bounds.minY <= b.gy + b.ey && o.bounds.maxY >= b.gy - b.ey && o.bounds.minZ <= b.gz + b.h && o.bounds.maxZ >= b.gz - b.h)).map(o => o.name)); },
      /* the dots' screen points, flat */
      dots: () => [].concat(...M().boxDots().map(o => [o.move, o.resizeH, o.resizeXY])),
      /* a point "inside" the boxes for a click: on a selected move (or the selected piece's top), at
         least minPx from every dot, on the bare canvas - inside a box's footprint if there is one */
      insidePx: (minPx) => {
        const d = M().getDoc(), c = M().getView().renderer.domElement, bs = M().boxes();
        const dots = [].concat(...M().boxDots().map(o => [o.move, o.resizeH, o.resizeXY]));
        const far = p => dots.every(q => Math.hypot(p[0] - q[0], p[1] - q[1]) >= minPx);
        const bare = p => document.elementFromPoint(p[0], p[1]) === c;
        const cands = [];
        const ts = [0.5, 0.44, 0.56, 0.38, 0.62, 0.32, 0.68, 0.26, 0.74, 0.2, 0.8, 0.14, 0.86];
        if (d.kind === 'toolpath') {
          M().selection().forEach(s => ts.forEach(t => {
            const x = s.x0 + (s.x1 - s.x0) * t, y = s.y0 + (s.y1 - s.y0) * t, p = pxOf(x, y, s.z);
            if (far(p) && bare(p)) cands.push({ at: p, inside: bs.some(b => inBox(b, x, y, s.z)), on: s.mv.index });
          }));
        } else {
          M().selection().forEach(o => { const b = o.bounds; ts.forEach(fx => ts.forEach(fy => {
            const x = b.minX + (b.maxX - b.minX) * fx, y = b.minY + (b.maxY - b.minY) * fy, p = pxOf(x, y, b.maxZ);
            if (far(p) && bare(p)) cands.push({ at: p, inside: bs.some(b2 => inBox(b2, x, y, b.maxZ)), on: o.name });
          })); });
        }
        return cands.find(q => q.inside) || cands[0] || null;
      }
    };
  })();
  window.__dl = [];
  window.downloadBlob = function (blob, name) { window.__dl.push({ name: name, size: blob.size }); };
`;
const plate = page => page.evaluate(() => NSO_MICROSCOPE.plate());

/* The hover, waited for. A hover is drawn on G-scope's own clock - at most one
   every 40 ms, the last move of a burst on a timer when the 40 ms are up - and
   behind the box's frames, so a fixed wait races it. Polled until it answers, up to HOVER_FRAMES of the page's
   animation frames: { info, kids, cursor, ms, frames }, `info` null if nothing came in time - never read off a
   null. Frames, not 2 s: the hover waits on frames, and a runner starved for CPU draws fewer of them a second
   (the 2 s ran out with nothing drawn yet on Tests #289 shard 6). 120 is the 2 s at 60 frames a second. The
   wall clock only bounds a hang (HOVER_HANG_MS); it is not the gate. */
const HOVER_FRAMES = 120, HOVER_HANG_MS = 20000;
async function waitHover(page, frames) {
  const limit = frames || HOVER_FRAMES, t0 = Date.now();
  await page.evaluate(() => {
    const F = window.__hoverFrames = { n: 0, on: true };
    (function tick() { if (!F.on) return; F.n++; requestAnimationFrame(tick); })();
  });
  for (;;) {
    const h = await page.evaluate(() => ({ info: NSO_MICROSCOPE.hoverInfo(), kids: NSO_MICROSCOPE.getView().hoverGroup.children.length,
                                           cursor: NSO_MICROSCOPE.getView().renderer.domElement.style.cursor, frames: window.__hoverFrames.n }));
    const el = Date.now() - t0;
    if (h.info || h.frames >= limit || el >= HOVER_HANG_MS) {
      await page.evaluate(() => { window.__hoverFrames.on = false; });
      return Object.assign(h, { ms: el });
    }
    await page.waitForTimeout(20);
  }
}
const hoverSays = h => (h.info ? J(h.info) + ' - after ' : 'no hover after ') + h.frames + ' frames, ' + h.ms + ' ms';
const lensState = page => page.evaluate(() => window.__t.state('lens'));
const iso = page => page.evaluate(() => NSO_MICROSCOPE.isIsolated());
const infoText = page => page.evaluate(() => document.getElementById('ms-info').textContent);

async function drag(page, from, to) {
  await page.mouse.move(from[0], from[1]);
  await page.mouse.down();
  await page.mouse.move((from[0] + to[0]) / 2, (from[1] + to[1]) / 2, { steps: 4 });
  await page.mouse.move(to[0], to[1], { steps: 5 });
  await page.mouse.up();
  await frames(page);
}
/* The plates stand side by side and a click on one makes it active (docs/GSCOPE.md); these checks are
   about selecting, so the plate is made active through the engine's own call. */
const activate = async (page, n) => { await page.evaluate(n => NSO_MICROSCOPE.showPlate(n), n); await frames(page); };
async function showLens(page) { if (await plate(page) !== 'lens') await activate(page, 'lens'); }
/* REGION is the card's one mode control, a toggle: armed is mode 'select'. Pressed until it says `on`. */
async function region(page, on) {
  if ((await page.evaluate(() => NSO_MICROSCOPE.mode())) !== (on ? 'select' : 'piece')) await page.click('#ms-mode-select');
  await frames(page);
  return page.evaluate(() => NSO_MICROSCOPE.mode());
}
/* A real wheel over `at`, notch by notch, until the document reads `want` px a mm there (or 120 notches). */
async function zoomOn(page, at, mm, want) {
  await page.mouse.move(at[0], at[1]);
  for (let i = 0; i < 120; i++) {
    if (await page.evaluate(([x, y, z]) => window.__t.mmPx(x, y, z), mm) >= want) break;
    await page.mouse.wheel(0, -100);
    if (i % 4 === 3) await frames(page);
  }
  await frames(page);
  return page.evaluate(([x, y, z]) => window.__t.mmPx(x, y, z), mm);
}
/* The card's rows that show on its side. */
const rowsShown = page => page.evaluate(() => Array.from(document.querySelectorAll('#ms-main-card .ms-row'))
  .filter(r => getComputedStyle(r).display !== 'none' && r.getBoundingClientRect().height > 0).map(r => r.id));

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

  /* plate 2's bed pixels are read once a view: the opening view is the same for every pull */
  const bedPoints = async () => {
    const out = [];
    for (const [x, y] of [[-30, -25], [-12, -25], [6, -25], [24, -25], [-30, 0], [-12, 0], [6, 0], [24, 0]]) out.push(await page.evaluate(([x, y]) => window.__t.bedPx(x, y), [x, y]));
    return out;
  };
  let dest = await bedPoints();

  /* ------------------------------------------------------------------ 1 */
  console.log('\n=== 1. the card ===');
  {
    const r = await page.evaluate(GONE => {
      const $ = id => document.getElementById(id);
      const card = $('ms-main-card'), cb = card.getBoundingClientRect(), ob = $('ms-btn-open').getBoundingClientRect(), mb = $('ms-btn-import-more').getBoundingClientRect();
      const head = card.querySelector('.ms-main-head'), sw = $('ms-camera-row'), menu = $('ms-import-menu');
      return {
        gone: GONE.filter(id => !!$(id)),
        card: { cls: card.className, isCard: card.classList.contains('ms-card'), open: card.classList.contains('is-open'), side: card.dataset.side,
                left: Math.round(cb.left), top: Math.round(cb.top), shown: cb.width > 0 && cb.height > 0 },
        cardBottom: $('microscope').style.getPropertyValue('--ms-card-bottom'),
        head: { open: !!(head && head.contains($('ms-btn-open'))), more: !!(head && head.contains($('ms-btn-import-more'))), sw: !!(head && head.contains(sw)),
                text: $('ms-btn-open').textContent.trim().toUpperCase(), more2: $('ms-btn-import-more').textContent.trim() },
        importBox: [ob.left, ob.top, ob.height, mb.right - ob.left].map(v => +v.toFixed(1)),
        shellW: parseFloat(getComputedStyle($('microscope')).getPropertyValue('--shell-col-w')),
        menu: { cls: menu.className, nav: menu.dataset.nav, role: menu.getAttribute('role'), open: menu.classList.contains('is-open'),
                plate: !!menu.contains($('ms-btn-plate')), plateRole: $('ms-btn-plate').getAttribute('role'), plateText: $('ms-btn-plate').textContent.trim() },
        sw: { cls: sw.className, kids: Array.from(sw.children).map(e => e.id || e.className), text: [$('ms-cam-normal').textContent.trim(), $('ms-cam-slice').textContent.trim()],
              normalOff: $('ms-cam-normal').disabled, sliceOff: $('ms-cam-slice').disabled, sliceOn: $('ms-cam-slice').classList.contains('active'),
              pressed: [$('ms-cam-normal').getAttribute('aria-pressed'), $('ms-cam-slice').getAttribute('aria-pressed')] },
        side: [NSO_MICROSCOPE.cardSide(), NSO_GSCOPE_SLICE.viewMode()],
        rowsOn: Array.from(card.querySelectorAll('.ms-row')).map(r => r.id + ':' + r.dataset.on),
        region: { text: $('ms-mode-select').textContent.trim(), off: $('ms-mode-select').disabled, pressed: $('ms-mode-select').getAttribute('aria-pressed'),
                  inRow: ['ms-mode-select', 'ms-btn-isolate', 'ms-btn-clear', 'ms-region-note'].every(id => $(id).closest('#ms-region-row')),
                  iso: $('ms-btn-isolate').disabled, clear: $('ms-btn-clear').disabled, clearText: $('ms-btn-clear').textContent.trim(), note: $('ms-region-note').hidden },
        band: ['ms-btn-take-band', 'ms-band-read'].every(id => $(id).closest('#ms-band-row')),
        render: ['ms-render-toolpath', 'ms-render-solid', 'ms-render-read'].every(id => $(id).closest('#ms-render-row')),
        settings: { folded: $('ms-slice-settings').hidden, expanded: $('ms-slice-settings-toggle').getAttribute('aria-expanded'),
                    inRow: ['ms-slice-nozzle', 'ms-slice-layer', 'ms-slice-walls', 'ms-slice-density', 'ms-slice-pattern', 'ms-slice-angle', 'ms-slice-settings-note'].every(id => $(id).closest('#ms-slice-settings')),
                    nozzle: $('ms-slice-nozzle').value, nozzles: Array.from($('ms-slice-nozzle').options).map(o => o.value), layer: $('ms-slice-layer').value,
                    rest: ['ms-slice-walls', 'ms-slice-density', 'ms-slice-pattern', 'ms-slice-angle'].map(id => $(id).value), profile: NSO_GSCOPE_SLICE.profileDefaults() },
        whole: $('ms-btn-back').textContent.trim(),
        checkAll: !!$('ms-btn-show-all').closest('.ms-legend-head') && $('ms-btn-show-all').nextElementSibling === $('ms-legend-toggle'),
        mode: NSO_MICROSCOPE.mode()
      };
    }, GONE);
    check('the column, the SELECT and VIEW cards and every control they held are gone (no old id is left)', r.gone.length === 0, r.gone.join(',') || 'all gone');
    check('ONE permanent card, top-left: #ms-main-card, not a pop-up card, never open, on the document\'s side, publishing its bottom edge',
      r.card.cls === 'ms-main-card' && !r.card.isCard && !r.card.open && r.card.shown && r.card.left <= 16 && r.card.top <= 16 && /^\d+px$/.test(r.cardBottom), J([r.card, r.cardBottom]));
    check('its head: IMPORT and its ▾, and the switch', r.head.open && r.head.more && r.head.sw && r.head.text === 'IMPORT' && r.head.more2 === '▾', J(r.head));
    check('IMPORT sits where the main page\'s Import slab is (left 8, top 8, 36 high) and IMPORT + ▾ is the column\'s 118 px',
      Math.abs(r.importBox[0] - 8) <= 1 && Math.abs(r.importBox[1] - 8) <= 1 && Math.abs(r.importBox[2] - 36) <= 1 && Math.abs(r.importBox[3] - r.shellW) <= 1 && r.shellW === 118, J([r.importBox, r.shellW]));
    check('the ▾ menu holds Read plate, a menu item, and is shut', r.menu.cls === 'ms-card ms-menu' && r.menu.nav === 'ms-btn-import-more' && r.menu.role === 'menu' &&
      !r.menu.open && r.menu.plate && r.menu.plateRole === 'menuitem' && r.menu.plateText === 'Read plate', J(r.menu));
    check('the switch: Normal . track . Slice ("Slice", not "Slice view")', /\bms-switch\b/.test(r.sw.cls) && J(r.sw.kids) === J(['ms-cam-normal', 'ms-switch-track', 'ms-cam-slice']) &&
      J(r.sw.text) === J(['Normal', 'Slice']), J(r.sw));
    check('an imported slice is the Slice side: the switch on Slice, Normal off (no mesh to go back to)',
      r.card.side === 'slice' && J(r.side) === J(['slice', 'slice']) && r.sw.sliceOn && J(r.sw.pressed) === J(['false', 'true']) && r.sw.normalOff && !r.sw.sliceOff, J([r.side, r.sw]));
    check('each row names its sides: REGION both, WHOLE PART Normal; TAKE BAND, Toolpath | Solid, Slice settings Slice',
      J(r.rowsOn) === J(['ms-region-row:normal slice', 'ms-whole-row:normal', 'ms-band-row:slice', 'ms-render-row:slice', 'ms-slice-row:slice', 'ms-measure-row:slice', 'ms-play-row:slice']), J(r.rowsOn));
    const shownRows = await rowsShown(page);
    check('the Slice side shows exactly 6 rows: REGION, TAKE BAND, Toolpath | Solid, Slice settings, Measure, Play',
      J(shownRows) === J(['ms-region-row', 'ms-band-row', 'ms-render-row', 'ms-slice-row', 'ms-measure-row', 'ms-play-row']), J(shownRows));
    check('REGION\'s row: Region (off), Isolate, Clear boxes (both off with no box) and its note (hidden while not armed)',
      r.region.text === 'Region' && !r.region.off && r.region.pressed === 'false' && r.region.inRow && r.region.iso && r.region.clear && r.region.clearText === 'Clear boxes' && r.region.note, J(r.region));
    check('TAKE BAND and Toolpath | Solid keep their ids in their rows; WHOLE PART is "Whole part"', r.band && r.render && r.whole === 'Whole part', J([r.band, r.render, r.whole]));
    check('Slice settings: folded, defaults the plate\'s printer profile (A1 mini: nozzle 0.4, layer 0.2; walls 2, 15 %, grid, 30)',
      r.settings.folded && r.settings.expanded === 'false' && r.settings.inRow && r.settings.nozzle === '0.4' && J(r.settings.nozzles) === J(['0.4', '0.6']) && r.settings.layer === '0.2' &&
      J(r.settings.rest) === J(['2', '15', 'grid', '30']) && J(r.settings.profile) === J({ printer: 'a1mini', nozzle: 0.4, layer: 0.2 }), J(r.settings));
    check('Check all is in the Features list\'s head, beside its minimize toggle', r.checkAll);
    // the old five-mode row is gone: two modes are left, and the others fall back to the piece
    const modes = await page.evaluate(() => { const M = NSO_MICROSCOPE, o = {};
      ['feature', 'line', 'layer', 'orbit', 'region', 'select', 'piece'].forEach(m => { M.setMode(m); o[m] = M.mode(); }); return o; });
    check('the modes are piece and select (REGION) only: feature / line / layer / orbit fall back to piece, region is select',
      r.mode === 'piece' && J(modes) === J({ feature: 'piece', line: 'piece', layer: 'piece', orbit: 'piece', region: 'select', select: 'select', piece: 'piece' }), J(modes));
    await shot('01-card-slice-side');
    // REGION is a toggle
    await page.click('#ms-mode-select'); await frames(page);
    const on = await page.evaluate(() => ({ mode: NSO_MICROSCOPE.mode(), active: document.getElementById('ms-mode-select').classList.contains('active'),
      pressed: document.getElementById('ms-mode-select').getAttribute('aria-pressed'), note: document.getElementById('ms-region-note').hidden }));
    await shot('01-card-slice-side-region-armed');
    await page.click('#ms-mode-select'); await frames(page);
    const off = await page.evaluate(() => ({ mode: NSO_MICROSCOPE.mode(), active: document.getElementById('ms-mode-select').classList.contains('active'),
      pressed: document.getElementById('ms-mode-select').getAttribute('aria-pressed'), note: document.getElementById('ms-region-note').hidden }));
    check('REGION is a toggle: a click arms it (active, pressed, its note up), a second disarms it',
      on.mode === 'select' && on.active && on.pressed === 'true' && !on.note && off.mode === 'piece' && !off.active && off.pressed === 'false' && off.note, J([on, off]));
    // the ▾ menu: opens from ▾; Escape shuts it (and only it); a press outside shuts it
    const menuOpen = () => page.evaluate(() => ({ open: document.getElementById('ms-import-menu').classList.contains('is-open'),
      exp: document.getElementById('ms-btn-import-more').getAttribute('aria-expanded'), shown: !!document.getElementById('ms-btn-plate').offsetParent, gs: NSO_MICROSCOPE.isOpen() }));
    await page.click('#ms-btn-import-more'); await frames(page);
    const m1 = await menuOpen();
    await shot('01-import-menu');
    await page.keyboard.press('Escape'); await frames(page);
    const m2 = await menuOpen();
    check('▾ opens the menu (Read plate shows); Escape shuts it and G-scope stays open', m1.open && m1.exp === 'true' && m1.shown && !m2.open && m2.exp === 'false' && m2.gs, J([m1, m2]));
    await page.click('#ms-btn-import-more'); await frames(page);
    const m3 = await menuOpen();
    await page.click('#ms-info'); await frames(page);      // the SELECTION / SEGMENT INFO readout: outside the menu, does nothing itself
    const m4 = await menuOpen();
    check('...a press outside the menu shuts it too', m3.open && !m4.open && m4.gs, J([m3, m4]));
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

  /* A fresh LENS: whole, nothing selected, no box, every type but Travel checked, the whole range, the piece. */
  const fresh = async () => {
    await showLens(page);
    await page.evaluate(() => { const M = NSO_MICROSCOPE; if (M.isIsolated()) M.back(); M.clearBoxes(); M.checkAll(); M.setFeatureDisplay('Travel', false);
      M.setZRange(0, 1e6); M.flushView(); M.setSelectionMoves([]); M.setMode('piece'); M.normalView(); });
    await frames(page);
  };
  /* The screen point of the selection's first move (a slice) - to click "on the selection". */
  const pxSelection = () => page.evaluate(() => { const M = NSO_MICROSCOPE, s = M.selection()[0]; return window.__t.pxOf((s.x0 + s.x1) / 2, (s.y0 + s.y1) / 2, s.z); });
  let pulled = 0;
  /* 3: a press on `px` (whatever it takes there) and a drag onto plate 2: one new piece of `want` moves, LENS untouched. */
  async function pullCheck(label, px, want, what) {
    const before = await lensState(page);
    const n0 = await page.evaluate(() => window.__t.pieces().length);
    await drag(page, px, dest[pulled % dest.length]);
    const after = await page.evaluate(() => ({ plate: NSO_MICROSCOPE.plate(), pieces: window.__t.pieces() }));
    const piece = after.pieces[after.pieces.length - 1];
    check(label + ': a drag pulls it onto TAKE - one new piece with exactly ' + what + ' (' + want + ' move(s))',
      after.plate === 'take' && after.pieces.length === n0 + 1 && piece && piece.moves === want, J([after.plate, after.pieces.length, piece && piece.moves, want, piece && piece.name]));
    await activate(page, 'lens');
    const now = await lensState(page);
    check(label + ': LENS is byte-identical after the pull', now === before, now === before ? '' : before + ' -> ' + now);
    pulled++;
  }

  /* ------------------------------------------------------------------ 2 + 3 */
  console.log('\n=== 2. each way in: hover outlines, click isolates, click again / Escape un-isolates ===');
  console.log('=== 3. each way in: a drag pulls it onto TAKE, LENS untouched ===');
  /* Piece is the view's own click; Feature's home is the Features list (only the checked
     types are shown, and the view click takes what is shown of the piece). */
  const CASES = [
    ['piece', 'Piece', async () => {}, c => c.piece, null],
    ['feature', 'Feature (the Features list: only Outer wall checked, then a view click)', async () => {
      const names = await page.evaluate(() => Array.from(document.querySelectorAll('#ms-legend .ms-legend-item')).map(r => r.dataset.group));
      for (const n of names) if (n !== 'Outer wall') await page.click('#ms-legend .ms-legend-item[data-group="' + n + '"] .ms-legend-display');
      await frames(page);
    }, c => c.feature, ['Outer wall']]
  ];
  for (const [id, label, setup, expect, feats] of CASES) {
    await fresh();
    await setup();
    const want = await page.evaluate(() => window.__t.countWhere('Outer wall', 1));
    if (id === 'feature') check(label + ': only Outer wall is shown - the piece\'s shown moves ARE the feature\'s', want.piece === want.feature && want.feature === 12, J(want));
    let px = await page.evaluate(() => window.__t.pxSeg('Outer wall', 1));
    // hover
    await page.mouse.move(px[0] - 40, px[1] - 40);
    await page.mouse.move(px[0], px[1], { steps: 3 });
    const hv = await waitHover(page);
    const n = expect(want);
    check(label + ': hover outlines what a click would take (' + n + ' move(s))', !!hv.info && hv.info.source === 'pick' && hv.kids > 0 && hv.cursor === 'pointer' && hv.info.count === n, hoverSays(hv));
    if (id === 'piece') await shot('02-hover-piece');
    const hoverCount = hv.info ? hv.info.count : -1;
    // click isolates
    await page.mouse.click(px[0], px[1]);
    await page.waitForTimeout(120);
    const c1 = await page.evaluate(() => ({ iso: NSO_MICROSCOPE.isIsolated(), sel: NSO_MICROSCOPE.selection().length, src: NSO_MICROSCOPE.selectionSource(), detail: NSO_MICROSCOPE.getView().detailGroup.visible,
      overview: NSO_MICROSCOPE.getView().overviewGroup.visible, boxes: NSO_MICROSCOPE.boxes().length, plate: NSO_MICROSCOPE.plate(), feats: [...new Set(NSO_MICROSCOPE.selection().map(s => s.feature))].sort() }));
    check(label + ': a click isolates it - the selection alone is drawn, the rest is out of the view', c1.iso && c1.detail && !c1.overview && c1.sel === hoverCount && c1.src === 'pick' && c1.plate === 'lens' && c1.boxes === 0 &&
      (!feats || J(c1.feats) === J(feats)), J(c1));
    if (id === 'feature') await shot('03-isolated-feature');
    // click it again
    px = await pxSelection();
    await page.mouse.click(px[0], px[1]);
    await page.waitForTimeout(120);
    check(label + ': clicked again, it is whole again (the selection stays)', await page.evaluate(() => !NSO_MICROSCOPE.isIsolated() && NSO_MICROSCOPE.getView().overviewGroup.visible && NSO_MICROSCOPE.selection().length > 0));
    // click the selection to isolate it again, then Escape
    px = await pxSelection();
    await page.mouse.click(px[0], px[1]);
    await page.waitForTimeout(120);
    check(label + ': a click on the selection isolates it again', await iso(page));
    await page.keyboard.press('Escape');
    await frames(page);
    check(label + ': Escape un-isolates, and G-scope stays open', await page.evaluate(() => !NSO_MICROSCOPE.isIsolated() && NSO_MICROSCOPE.isOpen()));
    // pull: a fresh selection, so what is pressed is the hover and not the selection
    await page.evaluate(() => { const M = NSO_MICROSCOPE; M.setSelectionMoves([]); M.normalView(); });
    await frames(page);
    px = await page.evaluate(() => window.__t.pxSeg('Outer wall', 1));
    await page.mouse.move(px[0], px[1]);
    const hv2 = (await waitHover(page)).info;
    await pullCheck(label, px, hv2 ? hv2.count : -1, 'the hovered ' + (id === 'feature' ? 'Outer wall moves of the piece' : 'piece'));
  }

  // Line: its home is the hover readout (SELECTION / SEGMENT INFO); isolating one move from the UI is dropped.
  {
    const label = 'Line (the hover readout)';
    await fresh();
    const tgt = await page.evaluate(() => window.__t.segOf('Outer wall', 1));
    const want = await page.evaluate(() => window.__t.countWhere('Outer wall', 1));
    const info0 = await infoText(page);
    const px = await page.evaluate(() => window.__t.pxSeg('Outer wall', 1));
    await page.mouse.move(px[0] - 40, px[1] - 40);
    await page.mouse.move(px[0], px[1], { steps: 3 });
    const hv = await waitHover(page);
    const read = await infoText(page);
    const m = /^Move (\d+) - ([^,]+), layer (\d+), Z ([\d.]+) mm/.exec(read);
    const seg = m ? await page.evaluate(i => { const s = NSO_MICROSCOPE.getDoc().segments.find(g => g.mv.index === i); return s ? { feature: s.feature, layer: s.layer, z: s.z } : null; }, +m[1] - 1) : null;
    check(label + ': hovering a move reads it out in SELECTION / SEGMENT INFO: "Move ' + (tgt.index + 1) + ' - Outer wall, layer 2, Z 0.400 mm ..."',
      !!hv.info && !!m && +m[1] === tgt.index + 1 && !!seg && m[2] === seg.feature && +m[3] === seg.layer + 1 && Math.abs(+m[4] - seg.z) < 1e-6, J(read) + ' ' + hoverSays(hv));
    await shot('02-hover-line-readout');
    const empty = await page.evaluate(() => window.__t.emptyPx());
    await page.mouse.move(empty[0], empty[1], { steps: 3 });
    let back = '';
    for (let t0 = Date.now(); Date.now() - t0 < 2000; await page.waitForTimeout(20)) { back = await infoText(page); if (!/^Move \d+/.test(back)) break; }
    check(label + ': off the move, the readout says again what it said before', back === info0, J([info0.slice(0, 60), back.slice(0, 60)]));
    // a click on that move takes the piece: isolating one move from the UI is dropped
    await page.mouse.move(px[0] - 40, px[1] - 40);
    await page.mouse.move(px[0], px[1], { steps: 3 });
    await waitHover(page);
    await page.mouse.click(px[0], px[1]);
    await page.waitForTimeout(120);
    const c = await page.evaluate(() => ({ iso: NSO_MICROSCOPE.isIsolated(), src: NSO_MICROSCOPE.selectionSource(), n: NSO_MICROSCOPE.selection().length }));
    check(label + ': a click on the move isolates the piece, not the move (one move is the API\'s now)', c.iso && c.src === 'pick' && c.n === want.piece, J(c));
    await page.keyboard.press('Escape'); await frames(page);
    // the pull of one move: the API is its home (pickLine), the drag is the view's
    await page.evaluate(i => { const M = NSO_MICROSCOPE; M.setSelectionMoves([]); M.normalView(); M.pickLine(i); }, tgt.index);
    await frames(page);
    const picked = await page.evaluate(() => ({ n: NSO_MICROSCOPE.selection().length, src: NSO_MICROSCOPE.selectionSource() }));
    check(label + ': pickLine (API) picks one move', picked.n === 1 && picked.src === 'line', J(picked));
    await pullCheck(label + ' (a move picked through the API)', await pxSelection(), 1, 'the picked move');
  }

  // Layer: its home is the slider (#ms-zr) + Take band, on the Slice side.
  {
    const label = 'Layer (the slider + Take band)';
    await fresh();
    const want = await page.evaluate(() => window.__t.countWhere('Outer wall', 1));
    // the slider's two handles, by their keys: the low one up a layer, the high one down a layer
    await page.focus('#ms-zr-lo'); await page.keyboard.press('ArrowUp');
    await page.focus('#ms-zr-hi'); await page.keyboard.press('ArrowDown');
    await page.evaluate(() => NSO_MICROSCOPE.flushView()); await frames(page);
    const z = await page.evaluate(() => ({ zr: NSO_MICROSCOPE.zRange(), shown: NSO_MICROSCOPE.shownCount(), band: !document.getElementById('ms-btn-take-band').disabled }));
    check(label + ': the slider narrowed to one layer (layer 2) shows its ' + want.layer + ' moves, and Take band is on',
      z.zr.lo === 1 && z.zr.hi === 1 && z.shown === want.layer && z.band, J(z));
    await page.click('#ms-btn-take-band');
    await frames(page);
    const t = await page.evaluate(() => ({ iso: NSO_MICROSCOPE.isIsolated(), n: NSO_MICROSCOPE.selection().length, zi: [...new Set(NSO_MICROSCOPE.selection().map(s => s.zi))],
      src: NSO_MICROSCOPE.selectionSource(), mode: NSO_MICROSCOPE.mode(), read: document.getElementById('ms-band-read').textContent }));
    check(label + ': Take band isolates exactly that layer, as one piece (source range) - and leaves the mode as it was',
      t.iso && t.n === want.layer && J(t.zi) === J([1]) && t.src === 'range' && t.mode === 'piece', J(t));
    await shot('03-isolated-band');
    let px = await pxSelection();
    await page.mouse.click(px[0], px[1]);
    await page.waitForTimeout(120);
    check(label + ': clicked again, it is whole again (the selection stays)', await page.evaluate(n => !NSO_MICROSCOPE.isIsolated() && NSO_MICROSCOPE.selection().length === n, want.layer));
    px = await pxSelection();
    await page.mouse.click(px[0], px[1]);
    await page.waitForTimeout(120);
    check(label + ': a click on the band isolates it again', await iso(page));
    await page.keyboard.press('Escape'); await frames(page);
    check(label + ': Escape un-isolates, and G-scope stays open', await page.evaluate(() => !NSO_MICROSCOPE.isIsolated() && NSO_MICROSCOPE.isOpen()));
    // the band, taken, whole again (the opening view: plate 2 where it was), and dragged: one piece
    await page.click('#ms-btn-take-band');
    await frames(page);
    px = await pxSelection();
    await page.mouse.click(px[0], px[1]);
    await page.waitForTimeout(120);
    check(label + ': taken again and clicked, the band is the selection, whole', await page.evaluate(n => !NSO_MICROSCOPE.isIsolated() && NSO_MICROSCOPE.selection().length === n &&
      NSO_MICROSCOPE.selectionSource() === 'range', want.layer));
    await pullCheck(label, await pxSelection(), want.layer, 'the band\'s moves');
    await page.click('#ms-zr-all'); await page.evaluate(() => NSO_MICROSCOPE.flushView()); await frames(page);
    check(label + ': All gives the whole range back', await page.evaluate(() => NSO_MICROSCOPE.shownCount()) === want.all);
  }

  // REGION (item 7), on the 51-move slice. Zoomed in on the part (a real wheel) so a box is big enough
  // on screen to click inside it away from its dots.
  {
    const label = 'Region';
    await fresh();
    const mmPx = await zoomOn(page, await page.evaluate(() => window.__t.pxOf(22, 15, 0.4)), [20, 10, 0.4], 12);
    check(label + ': zoomed in on the part with the wheel (' + mmPx.toFixed(1) + ' px a mm)', mmPx >= 12);
    const armed = await region(page, true);
    let px = await page.evaluate(() => window.__t.pxSeg('Outer wall', 1));
    await page.mouse.move(px[0] - 40, px[1] - 40);
    await page.mouse.move(px[0], px[1], { steps: 3 });
    const hv = await waitHover(page);
    check(label + ': armed, hover shows the box a click would place, and what it would hold', armed === 'select' && !!hv.info && hv.info.source === 'box' && hv.info.count > 0 && hv.kids > 0 && hv.cursor === 'pointer', hoverSays(hv));
    await page.mouse.click(px[0], px[1]);
    await page.waitForTimeout(120);
    const st = () => page.evaluate(() => ({ iso: NSO_MICROSCOPE.isIsolated(), boxes: NSO_MICROSCOPE.boxes().length, src: NSO_MICROSCOPE.selectionSource(), sel: window.__t.selIds(),
      holds: window.__t.boxHolds(), mode: NSO_MICROSCOPE.mode(), plate: NSO_MICROSCOPE.plate(), isoBtn: document.getElementById('ms-btn-isolate').disabled, clearBtn: document.getElementById('ms-btn-clear').disabled }));
    const p1 = await st();
    check(label + ': a click PLACES a box and isolates NOTHING - the selection is what the box holds (ids), Isolate and Clear boxes on',
      p1.boxes === 1 && !p1.iso && p1.src === 'box' && p1.sel.length === (hv.info ? hv.info.count : -1) && J(p1.sel) === J(p1.holds) && p1.mode === 'select' && !p1.isoBtn && !p1.clearBtn, J(p1));
    await shot('03-region-box-placed');
    // the corner dot, by a real drag: the box is resized; nothing is isolated
    const b0 = await page.evaluate(() => NSO_MICROSCOPE.boxes()[0]);
    const d0 = await page.evaluate(() => NSO_MICROSCOPE.boxDots()[0]);
    const to = [d0.resizeXY[0] + (d0.move[0] - d0.resizeXY[0]) * 0.45, d0.resizeXY[1] + (d0.move[1] - d0.resizeXY[1]) * 0.45];
    await drag(page, d0.resizeXY, to);
    const b1 = await page.evaluate(() => NSO_MICROSCOPE.boxes()[0]);
    const p2 = await st();
    check(label + ': a real drag of the corner dot resizes the box (X and Y) - and still isolates nothing; the selection follows it',
      p2.boxes === 1 && Math.abs(b1.rx - b0.rx) > 0.3 && Math.abs(b1.ry - b0.ry) > 0.3 && b1.gx === b0.gx && b1.gy === b0.gy && !p2.iso && p2.src === 'box' && J(p2.sel) === J(p2.holds) && p2.sel.length > 0,
      J([[b0.rx, b0.ry], [+b1.rx.toFixed(2), +b1.ry.toFixed(2)], p2]));
    // a second click (not on the selection, not in a box): a second box, the union
    px = await page.evaluate(() => window.__t.pxSeg('Support', 1));
    await page.mouse.move(px[0], px[1], { steps: 3 });
    await waitHover(page);
    await page.mouse.click(px[0], px[1]);
    await page.waitForTimeout(120);
    const p3 = await st();
    check(label + ': a second click places a second box - the selection is what both hold (the union)',
      p3.boxes === 2 && !p3.iso && J(p3.sel) === J(p3.holds) && p3.sel.length > p2.sel.length && p2.sel.every(i => p3.sel.indexOf(i) >= 0), J(p3));
    // a click inside a box, away from its dots: what the boxes hold is isolated
    const inside = await page.evaluate(() => window.__t.insidePx(15));
    if (inside) { await page.mouse.move(inside.at[0], inside.at[1], { steps: 3 }); await page.mouse.click(inside.at[0], inside.at[1]); await page.waitForTimeout(150); }
    const p4 = await st();
    check(label + ': a click INSIDE a box (on what it holds, 15+ px from every dot) isolates - the isolated set is exactly what the boxes hold',
      !!inside && p4.iso && p4.boxes === 2 && J(p4.sel) === J(p3.holds) && J(p4.sel) === J(p4.holds) && p4.isoBtn, J([inside, p4.sel, p3.holds]));
    await shot('03-region-isolated');
    const again = await page.evaluate(() => window.__t.insidePx(15));
    if (again) await page.mouse.click(again.at[0], again.at[1]);
    await page.waitForTimeout(150);
    const p5 = await st();
    check(label + ': clicked again, it is whole again (the boxes and their selection stay)', !!again && !p5.iso && p5.boxes === 2 && J(p5.sel) === J(p3.holds), J([again, p5]));
    await page.click('#ms-btn-isolate');
    await frames(page);
    const p6 = await st();
    check(label + ': Isolate does the same - exactly what the boxes hold, isolated', p6.iso && J(p6.sel) === J(p3.holds) && p6.isoBtn, J(p6));
    await page.keyboard.press('Escape'); await frames(page);
    const p7 = await st();
    check(label + ': Escape un-isolates first (both boxes stay)', !p7.iso && p7.boxes === 2 && await page.evaluate(() => NSO_MICROSCOPE.isOpen()), J(p7));
    await page.keyboard.press('Escape'); await frames(page);
    const p8 = await st(), left = await page.evaluate(() => NSO_MICROSCOPE.boxes()[0]);
    check(label + ': Escape on a box not isolated removes the last one placed - boxes 2 -> 1, the selection what the first holds',
      p8.boxes === 1 && !p8.iso && Math.abs(left.gx - b1.gx) < 1e-6 && J(p8.sel) === J(p8.holds) && J(p8.sel) === J(p2.sel) && p8.mode === 'select', J(p8));
    await page.click('#ms-btn-clear'); await frames(page);
    const p9 = await st();
    check(label + ': Clear boxes removes every box (and is off then)', p9.boxes === 0 && p9.sel.length === 0 && p9.clearBtn && p9.mode === 'select', J(p9));
    // a sparse spot (2a's leftover): no move's midpoint within the box a click would place - the
    // hover still shows that (empty) box, and the click still places it
    const half = Math.hypot(b1.rx, b1.ry) + 0.5;    // the next box takes the corner drag's size; any turn of it stays in this circle
    const spot = await page.evaluate(half => {
      const M = NSO_MICROSCOPE, d = M.getDoc(), c = M.getView().renderer.domElement, segs = d.segments.filter(s => M.hidden().indexOf(s.feature) < 0);
      let best = null;
      segs.forEach(s => { if (Math.hypot(s.x1 - s.x0, s.y1 - s.y0) < 8) return;
        for (let t = 0.04; t <= 0.96; t += 0.04) {
          const x = s.x0 + (s.x1 - s.x0) * t, y = s.y0 + (s.y1 - s.y0) * t;
          const near = Math.min(...segs.map(g => Math.hypot((g.x0 + g.x1) / 2 - x, (g.y0 + g.y1) / 2 - y)));
          const p = window.__t.pxOf(x, y, s.z);
          if (near > half && document.elementFromPoint(p[0], p[1]) === c && (!best || near > best.near)) best = { at: p, near: +near.toFixed(2), move: s.mv.index, xy: [+x.toFixed(2), +y.toFixed(2)] };
        } });
      return best;
    }, half);
    let hs = { info: null, ms: 0 };
    if (spot) { await page.mouse.move(spot.at[0] - 30, spot.at[1] - 30); await page.mouse.move(spot.at[0], spot.at[1], { steps: 3 }); hs = await waitHover(page); }
    check(label + ': on a sparse spot (no move midpoint within ' + half.toFixed(1) + ' mm) the hover still shows the box - holding nothing',
      !!spot && !!hs.info && hs.info.source === 'box' && hs.info.count === 0 && hs.kids > 0, J(spot) + ' ' + hoverSays(hs));
    if (spot) { await page.mouse.click(spot.at[0], spot.at[1]); await page.waitForTimeout(120); }
    const p10 = await st();
    check(label + ': ...and a click there places that empty box', p10.boxes === 1 && p10.sel.length === 0 && !p10.iso && p10.src === 'box', J(p10));
    await page.click('#ms-btn-clear'); await frames(page);
    // the pull: from REGION's hover (what the box would hold), a drag
    await page.evaluate(() => { const M = NSO_MICROSCOPE; M.setSelectionMoves([]); M.normalView(); });
    await frames(page);
    px = await page.evaluate(() => window.__t.pxSeg('Outer wall', 1));
    await page.mouse.move(px[0], px[1]);
    const hv2 = (await waitHover(page)).info;
    await pullCheck(label, px, hv2 && hv2.source === 'box' ? hv2.count : -1, 'what the hovered box would hold');
    check(label + ': ...and the pull placed no box', await page.evaluate(() => NSO_MICROSCOPE.boxes().length === 0));
    check(label + ': REGION off again: the toggle disarms it', await region(page, false) === 'piece');
  }
  await shot('04-after-the-pulls');

  /* ------------------------------------------------------------------ 4 */
  console.log('\n=== 4. the slider\'s range is one card ===');
  {
    await showLens(page);
    await page.evaluate(() => { const M = NSO_MICROSCOPE; M.clearBoxes(); M.checkAll(); M.setFeatureDisplay('Travel', false); if (M.isIsolated()) M.back(); M.setMode('piece'); M.setZRange(0, 1); M.flushView(); });
    await frames(page);
    const want = await page.evaluate(() => NSO_MICROSCOPE.shownCount());
    const full = await page.evaluate(() => NSO_MICROSCOPE.getDoc().segments.length);
    const card = await page.evaluate(() => { const b = document.getElementById('ms-zr-card').getBoundingClientRect(); return [b.left + b.width / 2, b.top + b.height / 2, b.width > 0]; });
    check('the slider has a Range card, and the range (two handles) narrows what is shown', card[2] && want > 0 && want < full, want + ' of ' + full + ' moves');
    await page.mouse.move(card[0], card[1]);
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
    const hv = await waitHover(page);       // the whole HOVER_FRAMES: an outline that came late would be caught
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
    check('two rows checked: exactly those two line types are drawn', J(two) === J(['Outer wall', 'Support']), J(two));
    // Select shown's button is gone: what is shown IS what a click takes (its API stays)
    const pxTwo = await page.evaluate(() => window.__t.pxSeg('Outer wall', 1));
    await page.mouse.move(pxTwo[0] - 40, pxTwo[1] - 40);
    await page.mouse.move(pxTwo[0], pxTwo[1], { steps: 3 });
    const hvTwo = await waitHover(page);
    await page.mouse.click(pxTwo[0], pxTwo[1]);
    await page.waitForTimeout(120);
    const clickTwo = await page.evaluate(() => ({ iso: NSO_MICROSCOPE.isIsolated(), n: NSO_MICROSCOPE.selection().length, shown: NSO_MICROSCOPE.shownCount(),
      feats: [...new Set(NSO_MICROSCOPE.selection().map(s => s.feature))].sort() }));
    check('...and a view click takes exactly those two - what is shown is the selection (Select shown has no button now)',
      !!hvTwo.info && hvTwo.info.count === clickTwo.shown && clickTwo.iso && J(clickTwo.feats) === J(['Outer wall', 'Support']), J([hvTwo.info, clickTwo]));
    await page.keyboard.press('Escape'); await frames(page);
    const twoShown = await page.evaluate(() => [...new Set(NSO_MICROSCOPE.selectVisible().map(s => s.feature))].sort());
    check('...the selectVisible API takes exactly those two too', J(twoShown) === J(['Outer wall', 'Support']), J(twoShown));
    await shot('06-two-checked');
    await page.evaluate(() => NSO_MICROSCOPE.setSelectionMoves([]));
    // uncheck all -> nothing
    await page.click(box('Outer wall'));
    await page.click(box('Support'));
    await frames(page);
    const none = { drawn: await drawnTypes(), count: await page.evaluate(() => NSO_MICROSCOPE.shownCount()), sel: await page.evaluate(() => NSO_MICROSCOPE.selectVisible().length) };
    check('every box unchecked: nothing is drawn, nothing is shown, nothing to take (selectVisible API: nothing)', none.drawn.length === 0 && none.count === 0 && none.sel === 0, J(none));
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
    // Check all: every box - from the list's own head now
    await page.click('#ms-btn-show-all');
    await frames(page);
    const all = await page.evaluate(() => ({ checks: Array.from(document.querySelectorAll('#ms-legend .ms-legend-display')).map(c => c.checked), off: NSO_MICROSCOPE.hidden(),
      label: document.getElementById('ms-btn-show-all').textContent.trim(), head: !!document.getElementById('ms-btn-show-all').closest('.ms-legend-head') }));
    check('Check all (the list\'s head, same id as Show all) checks every box - the whole piece', all.head && all.label === 'Check all' && all.checks.every(Boolean) && all.off.length === 0 && J(await drawnTypes()) === J(NAMES.slice().sort()), J(all));

    // whatever is shown is what a click / drag / export act on (a layer: the selectLayer API, one of the layer's homes)
    await page.evaluate(() => { NSO_MICROSCOPE.selectLayer(1); });
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
    const fromIso = await page.evaluate(() => { const M = NSO_MICROSCOPE, s = M.selection().find(g => g.feature === 'Outer wall'); return window.__t.pxOf((s.x0 + s.x1) / 2, (s.y0 + s.y1) / 2, s.z); });
    const destNow = await page.evaluate(() => window.__t.bedPx(20, 20));
    await drag(page, fromIso, destNow);
    const pulledPiece = await page.evaluate(() => window.__t.pieces().slice(-1)[0]);
    check('...and a drag copies only what is shown onto plate 2', pulledPiece && pulledPiece.moves === lay.n - lay.sup, J([pulledPiece && pulledPiece.moves, lay.n - lay.sup, from]));
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
  console.log('\n=== 6. the camera, the orbit, the arrows, the slider\'s steps, the Escape ladder ===');
  {
    await fresh();
    const cam0 = await page.evaluate(() => window.__t.cam());
    await region(page, true); await region(page, false);
    check('REGION on and off keeps the camera', await page.evaluate(() => window.__t.cam()) === cam0);
    for (const armed of [false, true]) {
      await region(page, armed);
      const empty = await page.evaluate(() => window.__t.emptyPx());
      const c0 = await page.evaluate(() => window.__t.cam()), n0 = await page.evaluate(() => window.__t.pieces().length);
      await drag(page, empty, [empty[0] - 70, empty[1] - 25]);
      const r = await page.evaluate(() => ({ cam: window.__t.cam(), plate: NSO_MICROSCOPE.plate(), n: window.__t.pieces().length, iso: NSO_MICROSCOPE.isIsolated(), sel: NSO_MICROSCOPE.selection().length,
        boxes: NSO_MICROSCOPE.boxes().length }));
      check((armed ? 'REGION armed' : 'Piece') + ': a drag on bare plate orbits - the camera moves, nothing is pulled, isolated, selected or boxed',
        r.cam !== c0 && r.plate === 'lens' && r.n === n0 && !r.iso && r.sel === 0 && r.boxes === 0, c0 + ' -> ' + r.cam);
      await page.evaluate(() => NSO_MICROSCOPE.normalView());
    }
    await region(page, false);
    // the arrows step a picked line - the API's pick (pickLine), the line's only home now
    const tgt = await page.evaluate(() => window.__t.segOf('Outer wall', 1));
    await page.evaluate(i => { const M = NSO_MICROSCOPE; M.pickLine(i); M.isolate(); }, tgt.index);
    await page.focus('#microscope');
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(120);
    const a1 = await page.evaluate(() => ({ idx: NSO_MICROSCOPE.selection()[0].mv.index, n: NSO_MICROSCOPE.selection().length, iso: NSO_MICROSCOPE.isIsolated() }));
    await page.keyboard.press('ArrowLeft');
    await page.waitForTimeout(120);
    const a2 = await page.evaluate(() => NSO_MICROSCOPE.selection()[0].mv.index);
    check('the arrows step a picked line (pickLine): Right to the next move, Left back, still isolated', a1.idx !== tgt.index && a1.n === 1 && a1.iso && a2 === tgt.index, J([tgt.index, a1, a2]));
    await shot('07-line-step');
    await page.keyboard.press('Escape'); await frames(page);
    // ...and nothing else: a piece selected, the arrows do not step
    await page.evaluate(() => NSO_MICROSCOPE.setSelectionMoves([]));
    const px = await page.evaluate(() => window.__t.pxSeg('Outer wall', 1));
    await page.mouse.move(px[0], px[1]); await waitHover(page);
    await page.mouse.click(px[0], px[1]); await page.waitForTimeout(120);
    const pick0 = await page.evaluate(() => ({ src: NSO_MICROSCOPE.selectionSource(), n: NSO_MICROSCOPE.selection().length }));
    await page.keyboard.press('ArrowRight'); await page.waitForTimeout(120);
    const pick1 = await page.evaluate(() => ({ src: NSO_MICROSCOPE.selectionSource(), n: NSO_MICROSCOPE.selection().length }));
    check('...only a picked line: with the piece selected the arrows do nothing', pick0.src === 'pick' && J(pick1) === J(pick0), J([pick0, pick1]));
    await page.keyboard.press('Escape'); await frames(page);
    // the layer's steps are the slider's handles now; Take band takes the stepped layer
    await page.evaluate(() => NSO_MICROSCOPE.setSelectionMoves([]));
    await page.focus('#ms-zr-hi'); await page.keyboard.press('Home');
    await page.evaluate(() => NSO_MICROSCOPE.flushView()); await frames(page);
    const z0 = await page.evaluate(() => NSO_MICROSCOPE.zRange());
    await page.click('#ms-btn-take-band'); await frames(page);
    const l0 = await page.evaluate(() => ({ zi: [...new Set(NSO_MICROSCOPE.selection().map(s => s.zi))], src: NSO_MICROSCOPE.selectionSource(), iso: NSO_MICROSCOPE.isIsolated(), mode: NSO_MICROSCOPE.mode() }));
    await page.focus('#ms-zr-hi'); await page.keyboard.press('ArrowUp');
    await page.focus('#ms-zr-lo'); await page.keyboard.press('ArrowUp');
    await page.evaluate(() => NSO_MICROSCOPE.flushView()); await frames(page);
    const z1 = await page.evaluate(() => NSO_MICROSCOPE.zRange());
    await page.click('#ms-btn-take-band'); await frames(page);
    const l1 = await page.evaluate(() => ({ zi: [...new Set(NSO_MICROSCOPE.selection().map(s => s.zi))], src: NSO_MICROSCOPE.selectionSource(), iso: NSO_MICROSCOPE.isIsolated(), mode: NSO_MICROSCOPE.mode() }));
    check('the slider\'s handles step the band a layer at a time, and Take band takes the layer it is on - the mode stays',
      z0.lo === 0 && z0.hi === 0 && J(l0.zi) === J([0]) && z1.lo === 1 && z1.hi === 1 && J(l1.zi) === J([1]) && l0.src === 'range' && l1.src === 'range' && l1.iso && l1.mode === 'piece', J([z0.lo, z0.hi, l0, z1.lo, z1.hi, l1]));
    await page.keyboard.press('Escape'); await frames(page);
    await page.click('#ms-zr-all'); await page.evaluate(() => { NSO_MICROSCOPE.flushView(); NSO_MICROSCOPE.setSelectionMoves([]); NSO_MICROSCOPE.normalView(); }); await frames(page);

    // the Escape ladder: the ▾ menu / Export -> isolated -> whole -> the box goes -> REGION disarms -> G-scope closes
    await region(page, true);
    const bp = await page.evaluate(() => window.__t.pxSeg('Outer wall', 1));
    await page.mouse.move(bp[0], bp[1], { steps: 3 }); await waitHover(page);
    await page.mouse.click(bp[0], bp[1]); await page.waitForTimeout(120);
    await page.click('#ms-btn-isolate'); await frames(page);
    const L = () => page.evaluate(() => ({ menu: document.getElementById('ms-import-menu').classList.contains('is-open'), exp: document.getElementById('ms-card-export').classList.contains('is-open'),
      iso: NSO_MICROSCOPE.isIsolated(), boxes: NSO_MICROSCOPE.boxes().length, mode: NSO_MICROSCOPE.mode(), open: NSO_MICROSCOPE.isOpen(),
      focus: document.activeElement ? document.activeElement.id || document.activeElement.tagName : null }));
    const e0 = await L();
    await page.click('#ms-btn-import-more'); await frames(page);
    const eMenu = await L();
    await page.keyboard.press('Escape'); await frames(page);
    const e1a = await L();
    check('Escape 1: the open ▾ menu shuts first (still isolated, the box kept, G-scope open)',
      e0.iso && e0.boxes === 1 && eMenu.menu && !e1a.menu && e1a.iso && e1a.boxes === 1 && e1a.open, J([e0, eMenu, e1a]));
    await page.click('#ms-nav-export'); await frames(page);
    const eExp = await L();
    await page.keyboard.press('Escape'); await frames(page);
    const e1b = await L();
    check('...and so does the open Export card', eExp.exp && !e1b.exp && e1b.iso && e1b.open, J([eExp, e1b]));
    await page.keyboard.press('Escape'); await frames(page);
    const e2 = await L();
    check('Escape 2: what is isolated is whole again (the box stays)', !e2.iso && e2.boxes === 1 && e2.mode === 'select' && e2.open, J(e2));
    await page.keyboard.press('Escape'); await frames(page);
    const e3 = await L();
    check('Escape 3: the box (not isolated) goes; REGION stays armed', !e3.iso && e3.boxes === 0 && e3.mode === 'select' && e3.open, J(e3));
    await page.keyboard.press('Escape'); await frames(page);
    const e4 = await L();
    check('Escape 4: REGION disarms', e4.mode === 'piece' && e4.open && await page.evaluate(() => document.getElementById('ms-mode-select').getAttribute('aria-pressed')) === 'false', J(e4));
    await page.keyboard.press('Escape'); await frames(page);
    const e5 = await L();
    check('Escape 5: with nothing left to undo, G-scope closes', !e5.open, J(e5));
    // open again: the imported slice comes back (a fresh visit). (Had the ladder stopped short, CLOSE
    // ends the visit so the sections after this one still run - the failed step stays failed.)
    if (await page.evaluate(() => NSO_MICROSCOPE.isOpen())) await page.click('#ms-close');
    await page.click('#btn-microscope');
    await page.waitForFunction(() => NSO_MICROSCOPE.isOpen() && NSO_MICROSCOPE.getDoc() && NSO_MICROSCOPE.getDoc().kind === 'toolpath', null, { timeout: 30000 });
    await frames(page);
    const re = await page.evaluate(() => ({ side: NSO_MICROSCOPE.cardSide(), mode: NSO_MICROSCOPE.mode(), n: NSO_MICROSCOPE.getDoc().segments.length,
      folded: document.getElementById('ms-slice-settings').hidden }));
    check('...and G-scope opens again on the imported slice, a fresh visit (Slice side, the piece, the settings folded)', re.side === 'slice' && re.mode === 'piece' && re.n === 51 && re.folded, J(re));
    dest = await bedPoints();
  }

  /* ------------------------------------------------------------------ 7 */
  console.log('\n=== 7. a plate piece: Piece and Region, and the dots (item 8) ===');
  {
    await showLens(page);
    await page.click('#ms-btn-import-more'); await frames(page);
    const menu = await page.evaluate(() => document.getElementById('ms-import-menu').classList.contains('is-open'));
    await page.click('#ms-btn-plate');
    await page.waitForFunction(() => NSO_MICROSCOPE.lensDoc() && NSO_MICROSCOPE.lensDoc().source === 'plate', null, { timeout: 30000 });
    await frames(page);
    const r = await page.evaluate(() => ({ menu: document.getElementById('ms-import-menu').classList.contains('is-open'), plate: NSO_MICROSCOPE.plate(),
      side: [NSO_MICROSCOPE.cardSide(), NSO_GSCOPE_SLICE.viewMode(), document.getElementById('ms-main-card').dataset.side],
      normal: [document.getElementById('ms-cam-normal').classList.contains('active'), document.getElementById('ms-cam-normal').disabled],
      slice: [document.getElementById('ms-cam-slice').classList.contains('active'), document.getElementById('ms-cam-slice').disabled],
      mode: NSO_MICROSCOPE.mode(), note: (document.querySelector('#ms-legend .ms-legend-note') || {}).textContent, rows: document.querySelectorAll('#ms-legend .ms-legend-item').length,
      whole: document.getElementById('ms-btn-back').disabled,
      fallback: ['feature', 'line', 'layer'].map(m => { NSO_MICROSCOPE.setMode(m); return NSO_MICROSCOPE.mode(); }) }));
    check('IMPORT ▾ -> Read plate: the menu opened, the choice shut it, and the plate is read onto the ACTIVE plate (plate 1)', menu && !r.menu && r.plate === 'lens', J([menu, r.menu, r.plate]));
    check('a mesh is the Normal side: the switch on Normal (on), Slice on to slice it', J(r.side) === J(['normal', 'normal', 'normal']) && J(r.normal) === J([true, false]) && J(r.slice) === J([false, false]), J(r));
    const nrows = await rowsShown(page);
    check('the Normal side shows exactly 2 rows: REGION and WHOLE PART', J(nrows) === J(['ms-region-row', 'ms-whole-row']), J(nrows));
    await shot('08-card-normal-side');
    check('on a mesh it is Piece and Region only - feature / line / layer fall back to the piece; the Features list says "not sliced"',
      J(r.fallback) === J(['piece', 'piece', 'piece']) && r.mode === 'piece' && /Not sliced/.test(r.note || '') && r.rows === 0 && r.whole, J(r));
    await page.evaluate(() => NSO_MICROSCOPE.normalView()); await frames(page);
    const px = await page.evaluate(() => window.__t.pxObject());
    await page.mouse.move(px[0], px[1]);
    const hv = await waitHover(page);
    check('Piece: hover outlines the piece', !!hv.info && hv.info.source === 'pick' && hv.info.count === 1 && hv.kids > 0, hoverSays(hv));
    await shot('08-plate-hover');
    await page.mouse.click(px[0], px[1]); await page.waitForTimeout(150);
    const w1 = await page.evaluate(() => ({ iso: NSO_MICROSCOPE.isIsolated(), n: NSO_MICROSCOPE.selection().length, whole: document.getElementById('ms-btn-back').disabled }));
    check('...click isolates it, and WHOLE PART is on', w1.iso && w1.n === 1 && !w1.whole, J(w1));
    await page.click('#ms-btn-back'); await frames(page);
    const w2 = await page.evaluate(() => ({ iso: NSO_MICROSCOPE.isIsolated(), n: NSO_MICROSCOPE.selection().length, whole: document.getElementById('ms-btn-back').disabled }));
    check('...WHOLE PART backs out of the isolate (the selection stays), and is off again', !w2.iso && w2.n === 1 && w2.whole, J(w2));
    const pxa = await page.evaluate(() => window.__t.pxObject());
    await page.mouse.click(pxa[0], pxa[1]); await page.waitForTimeout(150);
    await page.keyboard.press('Escape'); await frames(page);
    check('...a click isolates it again, Escape un-isolates', await iso(page) === false && await page.evaluate(() => NSO_MICROSCOPE.selection().length === 1));
    await page.evaluate(() => { NSO_MICROSCOPE.setSelectionMoves([]); NSO_MICROSCOPE.selectObjects([]); NSO_MICROSCOPE.normalView(); }); await frames(page);
    const px2 = await page.evaluate(() => window.__t.pxObject());
    const before = await lensState(page), n0 = await page.evaluate(() => window.__t.pieces().length);
    await drag(page, px2, dest[7]);
    const after = await page.evaluate(() => ({ plate: NSO_MICROSCOPE.plate(), pieces: window.__t.pieces() }));
    check('Piece: a drag pulls the piece onto TAKE', after.plate === 'take' && after.pieces.length === n0 + 1 && /box-20mm/.test(after.pieces[after.pieces.length - 1].name), J(after.pieces.map(p => p.name).slice(-1)));
    await activate(page, 'lens');
    check('LENS is byte-identical after it', await lensState(page) === before);

    // REGION on the mesh piece (item 7)
    const st = () => page.evaluate(() => ({ iso: NSO_MICROSCOPE.isIsolated(), boxes: NSO_MICROSCOPE.boxes().length, src: NSO_MICROSCOPE.selectionSource(), sel: window.__t.selIds(),
      holds: window.__t.boxHolds(), mode: NSO_MICROSCOPE.mode() }));
    const piece = await page.evaluate(() => NSO_MICROSCOPE.getDoc().objects[0].name);
    const mmPx = await zoomOn(page, await page.evaluate(() => window.__t.pxObject()), await page.evaluate(() => { const b = NSO_MICROSCOPE.getDoc().objects[0].bounds; return [(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2, b.maxZ]; }), 8);
    await region(page, true);
    const px3 = await page.evaluate(() => window.__t.pxObject());
    await page.mouse.move(px3[0] - 30, px3[1] - 30);
    await page.mouse.move(px3[0], px3[1], { steps: 3 });
    const hv3 = await waitHover(page);
    await page.mouse.click(px3[0], px3[1]); await page.waitForTimeout(150);
    const q1 = await st();
    check('Region on a mesh (zoomed in, ' + mmPx.toFixed(1) + ' px a mm): hover shows the box; the click places it and isolates NOTHING - the selection is the piece it holds',
      !!hv3.info && hv3.info.source === 'box' && hv3.info.count === 1 && q1.boxes === 1 && !q1.iso && q1.src === 'box' && J(q1.sel) === J([piece]) && J(q1.holds) === J([piece]), J([hv3.info, q1]));
    const mb0 = await page.evaluate(() => NSO_MICROSCOPE.boxes()[0]), md0 = await page.evaluate(() => NSO_MICROSCOPE.boxDots()[0]);
    await drag(page, md0.resizeXY, [md0.resizeXY[0] + (md0.resizeXY[0] - md0.move[0]) * 0.6, md0.resizeXY[1] + (md0.resizeXY[1] - md0.move[1]) * 0.6]);
    const mb1 = await page.evaluate(() => NSO_MICROSCOPE.boxes()[0]), q2 = await st();
    check('Region on a mesh: a real corner-dot drag resizes the box, still nothing isolated', Math.abs(mb1.rx - mb0.rx) > 0.3 && Math.abs(mb1.ry - mb0.ry) > 0.3 && !q2.iso && q2.boxes === 1 && J(q2.sel) === J(q2.holds),
      J([[mb0.rx, mb0.ry], [+mb1.rx.toFixed(2), +mb1.ry.toFixed(2)], q2]));
    const inside = await page.evaluate(() => window.__t.insidePx(15));
    if (inside) { await page.mouse.move(inside.at[0], inside.at[1], { steps: 3 }); await page.mouse.click(inside.at[0], inside.at[1]); await page.waitForTimeout(150); }
    const q3 = await st();
    check('Region on a mesh: a click inside the box, away from its dots, isolates exactly what it holds', !!inside && q3.iso && J(q3.sel) === J(q2.holds) && J(q3.sel) === J([piece]), J([inside, q3]));
    await shot('08-plate-region-isolated');
    const again = await page.evaluate(() => window.__t.insidePx(15));
    if (again) await page.mouse.click(again.at[0], again.at[1]);
    await page.waitForTimeout(150);
    const q4 = await st();
    check('...clicked again, whole again', !!again && !q4.iso && q4.boxes === 1, J([again, q4]));
    await page.click('#ms-btn-isolate'); await frames(page);
    const q5 = await st();
    check('...Isolate does the same', q5.iso && J(q5.sel) === J([piece]), J(q5));
    await page.keyboard.press('Escape'); await frames(page);
    await page.keyboard.press('Escape'); await frames(page);
    const q6 = await st();
    check('...Escape un-isolates, then removes the box', !q6.iso && q6.boxes === 0 && q6.mode === 'select', J(q6));
    await page.evaluate(() => NSO_MICROSCOPE.normalView()); await frames(page);

    // item 8: a box BEHIND the piece; its dots are drawn on top and take a real left press, armed or not
    for (const armed of [true, false]) {
      const tag = armed ? 'REGION armed' : 'REGION off (the piece\'s mode)';
      await region(page, armed);
      await page.evaluate(() => { const M = NSO_MICROSCOPE; M.clearBoxes(); M.selectObjects([]); M.normalView(); });
      await frames(page);
      const set = await page.evaluate(() => {
        const M = NSO_MICROSCOPE, d = M.getDoc(), v = M.getView(), b = d.objects[0].bounds;
        const C = M.toView((b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2, (b.minZ + b.maxZ) / 2), cam = v.camera.position.clone();
        const dir = C.clone().sub(cam); dir.y = 0; dir.normalize();
        const reach = Math.abs(dir.x) * (b.maxX - b.minX) / 2 + Math.abs(dir.z) * (b.maxY - b.minY) / 2;
        const P = C.clone().addScaledVector(dir, reach + 4);                        // 4 mm past the far side, at mid height
        const g = [P.x + d.cx, -P.z + d.cy, P.y];
        M.addBoxAt(g[0], g[1], g[2], 2.5, 1);
        const dot = M.boxDots()[0].move, rc = new THREE.Raycaster(cam, P.clone().sub(cam).normalize());
        const hit = rc.intersectObjects([v.overviewGroup], true).filter(h => h.object.isMesh && h.object.visible)[0];
        return { g: g.map(x => +x.toFixed(2)), dot, dist: +cam.distanceTo(P).toFixed(2), hit: hit ? +hit.distance.toFixed(2) : null,
                 hitPiece: hit && hit.object.userData.object ? hit.object.userData.object.name : null,
                 canvas: document.elementFromPoint(dot[0], dot[1]) === v.renderer.domElement, under: M.pressTargetAt(dot[0], dot[1]), box0: M.boxes()[0] };
      });
      await frames(page);
      check(tag + ': a box placed BEHIND the piece - a ray from the camera meets the piece before the centre dot',
        set.hit != null && set.hit < set.dist - 1 && set.hitPiece === piece && set.canvas && !!set.under && set.under.source === (armed ? 'box' : 'pick'), J(set));
      const n1 = await page.evaluate(() => window.__t.pieces().length);
      // a click (no travel) on the dot, where the piece is under it: nothing isolated, picked or boxed
      await page.mouse.move(set.dot[0], set.dot[1]);
      await page.mouse.click(set.dot[0], set.dot[1]); await page.waitForTimeout(120);
      const clk = await page.evaluate(() => ({ iso: NSO_MICROSCOPE.isIsolated(), src: NSO_MICROSCOPE.selectionSource(), boxes: NSO_MICROSCOPE.boxes().length,
        box: NSO_MICROSCOPE.boxes()[0], plate: NSO_MICROSCOPE.plate(), n: window.__t.pieces().length }));
      check(tag + ': a click on the dot (the piece under it) isolates nothing, picks nothing, places no box, moves nothing',
        !clk.iso && clk.src === 'box' && clk.boxes === 1 && J(clk.box) === J(set.box0) && clk.plate === 'lens' && clk.n === n1, J(clk));
      // a real press on it, and a drag
      await page.mouse.down();
      const down = await page.evaluate(() => { const v = NSO_MICROSCOPE.getView(); return { ds: v.dragState ? { type: v.dragState.type, ballIndex: v.dragState.ballIndex } : null, controls: v.controls.enabled }; });
      await page.mouse.move(set.dot[0] + 30, set.dot[1] + 20, { steps: 4 });
      await page.mouse.move(set.dot[0] + 60, set.dot[1] + 35, { steps: 4 });
      await page.mouse.up();
      await frames(page);
      const moved = await page.evaluate(() => ({ box: NSO_MICROSCOPE.boxes()[0], plate: NSO_MICROSCOPE.plate(), n: window.__t.pieces().length, iso: NSO_MICROSCOPE.isIsolated(),
        src: NSO_MICROSCOPE.selectionSource(), sel: window.__t.selIds() }));
      check(tag + ': a REAL left press on that dot is the box\'s - a handle drag (move), the orbit off - not the piece\'s',
        !!down.ds && down.ds.type === 'move' && down.ds.ballIndex === 0 && !down.controls, J(down));
      check(tag + ': ...dragged, the box moved - no pull, nothing isolated, the piece not picked',
        Math.hypot(moved.box.gx - set.box0.gx, moved.box.gy - set.box0.gy, moved.box.gz - set.box0.gz) > 1 && moved.plate === 'lens' && moved.n === n1 && !moved.iso && moved.src === 'box',
        J([set.box0, moved]));
    }
    // a right press on a dot is still the pan: the camera moves, the box does not
    {
      await page.evaluate(() => NSO_MICROSCOPE.normalView()); await frames(page);
      const b0 = await page.evaluate(() => NSO_MICROSCOPE.boxes()[0]), dot = await page.evaluate(() => NSO_MICROSCOPE.boxDots()[0].move);
      const t0 = await page.evaluate(() => window.__t.target());
      await page.mouse.move(dot[0], dot[1]);
      await page.mouse.down({ button: 'right' });
      const ds = await page.evaluate(() => !!NSO_MICROSCOPE.getView().dragState);
      await page.mouse.move(dot[0] + 40, dot[1] + 25, { steps: 6 });
      await page.mouse.up({ button: 'right' });
      await frames(page);
      const b1 = await page.evaluate(() => NSO_MICROSCOPE.boxes()[0]), t1 = await page.evaluate(() => window.__t.target());
      check('a RIGHT drag on a dot still pans: the view moves, the box does not', !ds && t1 !== t0 && J(b1) === J(b0), J([t0, t1, ds]));
    }
    // the dots: on top of everything, never under 6 px on screen
    {
      await page.evaluate(() => NSO_MICROSCOPE.normalView()); await frames(page);
      const dots = await page.evaluate(() => {
        const v = NSO_MICROSCOPE.getView(), r = v.renderer.domElement.getBoundingClientRect(), cam = v.camera, out = [];
        const right = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0).normalize();
        v.scene.children.forEach(o => {
          if (!o.isMesh || !o.material || !o.material.color) return;
          const hex = o.material.color.getHex();
          if ([0x5b8cff, 0xffb35b, 0x4cd97b].indexOf(hex) < 0) return;
          const a = o.position.clone().project(cam), b = o.position.clone().addScaledVector(right, o.scale.x).project(cam);
          out.push({ hex: hex.toString(16), depthTest: o.material.depthTest, order: o.renderOrder, px: +Math.hypot((b.x - a.x) / 2 * r.width, (b.y - a.y) / 2 * r.height).toFixed(2) });
        });
        return out;
      });
      check('the three dots are drawn on top (no depth test, renderOrder 20) and never under 6 px on screen',
        dots.length === 3 && J(dots.map(d => d.hex).sort()) === J(['4cd97b', '5b8cff', 'ffb35b']) && dots.every(d => d.depthTest === false && d.order === 20 && d.px >= 5.9), J(dots));
    }
    await page.evaluate(() => { const M = NSO_MICROSCOPE; M.clearBoxes(); M.selectObjects([]); });
    await region(page, false);
  }

  /* ------------------------------------------------------------------ 8 */
  console.log('\n=== 8. what left G-scope ===');
  {
    const r = await page.evaluate(GONE => ({
      detectedRow: !!document.getElementById('ms-detected'), liftRow: !!document.getElementById('ms-lift-row'), liftObj: typeof window.NSO_GSCOPE_LIFT,
      liftScript: !!document.querySelector('script[src*="app-gscope-lift"]'),
      api: ['flange', 'detectFlanges', 'toggleDetected', 'detectedOn', 'feature', 'featureRules', 'detectFeatures'].filter(k => typeof NSO_MICROSCOPE[k] === 'function'),
      only: !!document.querySelector('.ms-legend-only'), liftCss: !!document.querySelector('.ms-lift-group'),
      old: GONE.filter(id => !!document.getElementById(id)),
      kept: ['clearFromView', 'selectVisible', 'pickLine', 'stepLine', 'pickLineAt', 'selectLayer', 'takeBand', 'checkAll'].filter(k => typeof NSO_MICROSCOPE[k] !== 'function') }), GONE);
    check('no detector rows, no Features readout, no Lift script, no detector API', !r.detectedRow && !r.liftRow && r.liftObj === 'undefined' && !r.liftScript && r.api.length === 0 && !r.only, J(r));
    check('the old controls are gone (Select shown and Clear from view have no button); their APIs stay', r.old.length === 0 && r.kept.length === 0, J([r.old, r.kept]));
    // Clear from view's job is the corner CLEAR's: it empties the ACTIVE plate, the other is not touched
    await activate(page, 'take');
    const lens0 = await page.evaluate(() => JSON.parse(window.__t.state('lens')).sum), take0 = await page.evaluate(() => window.__t.pieces().length);
    await page.click('#ms-btn-take-clear'); await frames(page);
    const cl = await page.evaluate(() => ({ take: window.__t.pieces().length, lens: JSON.parse(window.__t.state('lens')).sum, plate: NSO_MICROSCOPE.plate() }));
    check('the corner CLEAR empties the active plate (plate 2 here) and leaves the other alone', take0 > 0 && cl.take === 0 && cl.lens === lens0 && cl.plate === 'take', J([take0, cl]));
    await activate(page, 'lens');
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
    await page.evaluate(() => NSO_MICROSCOPE.setMode('piece'));
  }

  /* ------------------------------------------------------------------ 10 */
  console.log('\n=== 10. an NSO slice of a piece and its supports: the support rows (slicer:supports) ===');
  {
    await activate(page, 'lens');
    const host = await loadSTL(page, CLIP);
    await page.waitForFunction(id => state.placed.some(p => p && p.sourceId === id), host, { timeout: 30000 });
    const picked = await page.evaluate(id => window.NSO_SUPPORTS_CARD.pick(id), host);
    await page.evaluate(() => window.NSO_SUPPORTS_CARD.generate());
    await page.waitForFunction(() => !window.NSO_SUPPORTS_CARD.busy(), null, { timeout: 120000 });
    const sups = await page.evaluate(id => state.models.filter(m => m.nsoSupport && m.nsoSupport.hostSourceId === id).map(m => m.name), host);
    check('the Supports card builds the clip coupon its two supports, at its defaults', picked.ok && sups.length === 2, J(sups));
    await page.click('#ms-btn-plate');           // IMPORT ▾ -> Read plate (the cards helper opens the ▾ first)
    await page.waitForFunction(() => NSO_MICROSCOPE.lensDoc() && NSO_MICROSCOPE.lensDoc().source === 'plate' && NSO_MICROSCOPE.lensDoc().kind === 'mesh', null, { timeout: 30000 });
    /* the nozzle and layer the card builds for (the sheet's 0.42 mm lines, 0.2 mm layers) are the
       A1 mini profile's defaults now - nothing to set (the row only shows on the Slice side) */
    const sett = await page.evaluate(() => ({ nozzle: document.getElementById('ms-slice-nozzle').value, layer: document.getElementById('ms-slice-layer').value, side: NSO_MICROSCOPE.cardSide() }));
    check('the Slice settings already hold the card\'s nozzle and layer (0.4 / 0.2, the printer profile\'s) - and a mesh is the Normal side', sett.nozzle === '0.4' && sett.layer === '0.2' && sett.side === 'normal', J(sett));
    await page.click('#ms-cam-slice');
    await page.waitForFunction(() => { const d = NSO_MICROSCOPE.getDoc(); return d && d.kind === 'toolpath' && d.nsoSlice && !NSO_GSCOPE_SLICE.busy(); }, null, { timeout: 120000 });
    await cards.closeCards(page);
    await frames(page);
    const sw = await page.evaluate(() => ({ side: [NSO_MICROSCOPE.cardSide(), NSO_GSCOPE_SLICE.viewMode()], slice: document.getElementById('ms-cam-slice').getAttribute('aria-pressed'),
      normalOff: document.getElementById('ms-cam-normal').disabled, label: document.getElementById('ms-cam-slice').textContent.trim() }));
    const srows = await rowsShown(page);
    check('the switch sliced it: the Slice side (6 rows), Normal on - a slice made here goes back to its mesh',
      J(sw.side) === J(['slice', 'slice']) && sw.slice === 'true' && !sw.normalOff && sw.label === 'Slice' && J(srows) === J(['ms-region-row', 'ms-band-row', 'ms-render-row', 'ms-slice-row', 'ms-measure-row', 'ms-play-row']), J([sw, srows]));
    const rows = await page.evaluate(() => Array.from(document.querySelectorAll('#ms-legend .ms-legend-item')).map(r => ({
      name: r.dataset.group, label: r.querySelector('.ms-legend-label').textContent, check: !!r.querySelector('input.ms-legend-display') })));
    const names = rows.map(r => r.name), at = names.indexOf('Support');
    check('the Features list shows the three support rows, Bambu order, each with its count and checkbox',
      at >= 0 && J(names.slice(at, at + 3)) === J(['Support', 'Support interface', 'Support transition']) &&
      rows.slice(at, at + 3).every(r => r.check && /\(\d+\)$/.test(r.label)), J(rows.map(r => r.label)));
    check('...and no wall or infill row comes from a support', await page.evaluate(() => {
      const d = NSO_MICROSCOPE.getDoc(), sup = new Set(d.nsoSlice.result.objects.filter(o => o.role === 'support').map(o => o.id));
      return d.segments.filter(g => sup.has(g.mv.objectId)).every(g => /^Support/.test(g.feature));
    }));
    const read = await page.evaluate(() => document.getElementById('ms-slice-read').textContent);
    check('the readout credits the host - the covering support named - and each support says what it holds',
      sups.every(n => read.includes('covered by ' + n.replace(/^.* - /, '').replace(/\s*\([^)]*\)$/, '') + ',')) &&
      (read.match(/: support for /g) || []).length === 2, read);
    /* a line type's home is the Features list: just Support interface checked, the view click takes all of it */
    await page.evaluate(() => { const M = NSO_MICROSCOPE; M.clearBoxes(); M.setSelectionMoves([]); if (M.isIsolated()) M.back(); M.setMode('piece'); });
    const boxOf = n => '#ms-legend .ms-legend-item[data-group="' + n + '"] input.ms-legend-display';
    const lblOf = n => '#ms-legend .ms-legend-item[data-group="' + n + '"] .ms-legend-label';
    for (const n of names) if (n !== 'Support interface' && await page.evaluate(sel => document.querySelector(sel).checked, boxOf(n))) await page.click(boxOf(n));
    await frames(page);
    const drawn = () => page.evaluate(() => { const v = NSO_MICROSCOPE.getView();
      return Object.keys(v.overviewMeshes).filter(k => { const m = v.overviewMeshes[k]; return m.visible && m.geometry.attributes.position.count > 0; }).sort(); });
    check('only Support interface checked: only its lines are drawn', J(await drawn()) === J(['Support interface']), J(await drawn()));
    await page.evaluate(() => NSO_MICROSCOPE.normalView());
    await frames(page);
    const layer = await page.evaluate(() => NSO_MICROSCOPE.getDoc().segments.find(g => g.feature === 'Support interface').layer);
    const want = await page.evaluate(l => window.__t.countWhere('Support interface', l), layer);
    const px = await page.evaluate(l => window.__t.pxSeg('Support interface', l), layer);
    await page.mouse.move(px[0] - 40, px[1] - 40);
    await page.mouse.move(px[0], px[1], { steps: 3 });
    const hv = await waitHover(page);
    check('the view click sees the row: hover takes the support\'s whole Support interface (' + want.feature + ' moves - all that is shown of it)',
      !!hv.info && hv.info.source === 'pick' && hv.info.count === want.feature && want.piece === want.feature, hoverSays(hv) + ' ' + J(want));
    await page.mouse.click(px[0], px[1]);
    await page.waitForTimeout(150);
    const c = await page.evaluate(() => ({ iso: NSO_MICROSCOPE.isIsolated(), feats: [...new Set(NSO_MICROSCOPE.selection().map(s => s.feature))] }));
    check('...a click isolates exactly it', c.iso && J(c.feats) === J(['Support interface']), J(c));
    await page.keyboard.press('Escape'); await frames(page);
    await page.click(lblOf('Support transition'));
    await frames(page);
    check('the row text toggles its box: Support transition checked, drawn beside the interface',
      await page.evaluate(sel => document.querySelector(sel).checked, boxOf('Support transition')) && J(await drawn()) === J(['Support interface', 'Support transition']), J(await drawn()));
    await page.evaluate(() => { const M = NSO_MICROSCOPE; M.setSelectionMoves([]); M.checkAll(); M.setFeatureDisplay('Travel', false); M.setMode('piece'); });
    await shot('10-support-rows');
  }

  const errs = logs.filter(l => /^\[pageerror\]/.test(l) || /^\[error\]/.test(l)).filter(l => !/Failed to load resource/.test(l));
  check('no page errors', errs.length === 0, errs.slice(0, 3).join(' | ') || 'none');
  console.log(fails ? '\n' + fails + ' FAILED' : '\nall gates held');
  process.exit(fails ? 1 : 0);
}).catch(e => { console.error('TEST CRASH', e); process.exit(1); });
