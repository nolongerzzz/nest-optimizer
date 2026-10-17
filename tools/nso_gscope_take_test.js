#!/usr/bin/env node
/* G-scope's second plate: LENS and TAKE (docs/GSCOPE-TAKE.md).

   LENS is what you loaded - the plate read, or an imported file. TAKE starts
   empty and holds COPIES pulled off LENS. One is shown at a time; the legend,
   readouts and slider follow the plate shown. Nothing on LENS ever changes.

   Every drive below is a real mouse: a press on the isolated thing and a drag,
   not a call.

   GATES
     1. The toggle: BACK . LENS|TAKE . CLEAR . EXPORT . CLOSE in the top-right
        row; LENS shown to begin with; a round trip leaves LENS as it was.
     2. Five pulls - a capture-box region, a picked line, a layer, a legend
        feature (all off a slice) and a whole piece (off the plate): the view
        flips to TAKE while the button is held, stays on TAKE after the drop,
        LENS is byte-identical afterwards (plateState: what is loaded, hidden,
        selected, boxed, the slider, the camera, a checksum of every
        coordinate). TAKE has five pieces.
     3. Refusals and edges: Escape mid-drag cancels and returns to LENS; a
        press that never travels is a click; a capture box's dots keep their
        press; a press on empty space still orbits.
     4. TAKE follows: legend, readouts, slider, header are TAKE's.
     5. Pieces on TAKE are grabbable and droppable like the main plate's (the
        same app-grab-drop): onto the bed, onto another piece (seated at the
        Seat gap), into the air; Escape puts one back; each pull is a copy.
     6. Export on TAKE: Whole plate -> main plate (five placed pieces, one
        Undo) / as STL; Selected piece -> main plate / as STL, as lines and as
        solid. On LENS: today's selection exports, unchanged.
     7. CLEAR empties TAKE; with Shift, LENS is dropped back to the plate;
        opening G-scope from the main plate re-reads the plate, an import
        stays.
     8. A double-click on the view does nothing; BACK / CLOSE are the exits.
     9. Watch's log docks bottom-right, under the slider's All button.

   Screenshots go to tools/gscope-take-out/ (git-ignored).

     node tools/nso_gscope_take_test.js       exit 0 = every gate held */

const path = require('path');
const fs = require('fs');
const { withApp, loadSTL, ROOT } = require('./nso_app_harness');

let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail ? ' - ' + detail : ''));
  if (!cond) fails++;
};
const SHOTS = path.join(ROOT, 'tools', 'gscope-take-out');
const SLICE = path.join(ROOT, 'fixtures', '3mf', 'toolpath-ground-truth.gcode.3mf');
const BOX = path.join(ROOT, 'fixtures', 'box-20mm.stl');

const frames = page => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
const J = JSON.stringify;

/* ------------------------------------------------------------- in the page */
const PAGE_HELPERS = `
  window.__t = (function () {
    const M = () => window.NSO_MICROSCOPE;
    const rect = () => M().getView().renderer.domElement.getBoundingClientRect();
    const toPx = (v) => {
      const p = v.clone().project(M().getView().camera), r = rect();
      return [r.left + (p.x + 1) / 2 * r.width, r.top + (1 - p.y) / 2 * r.height];
    };
    /* a G-code / Z-up point of the shown document, as a screen pixel */
    const pxOf = (x, y, z) => { const d = M().getDoc(); return toPx(new THREE.Vector3(x - d.cx, z, -(y - d.cy))); };
    return {
      state: (n) => JSON.stringify(M().plateState(n)),
      /* a selected move of the slice: its midpoint on screen */
      segPx: (pick) => {
        const sel = M().selection();
        const s = pick ? pick(sel) : sel[0];
        return pxOf((s.x0 + s.x1) / 2, (s.y0 + s.y1) / 2, s.z);
      },
      /* a point on a TAKE piece's own surface: its first triangle's centroid */
      piecePx: (name, tri) => {
        const o = M().getDoc().objects.find(x => x.name === name);
        const k = (tri || 0) * 9, p = o.positions;
        return pxOf((p[k] + p[k + 3] + p[k + 6]) / 3, (p[k + 1] + p[k + 4] + p[k + 7]) / 3, (p[k + 2] + p[k + 5] + p[k + 8]) / 3);
      },
      /* the middle of a piece's top face, a hair above it */
      topPx: (name) => {
        const o = M().getDoc().objects.find(x => x.name === name), b = o.bounds;
        return pxOf((b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2, b.maxZ);
      },
      /* a point on TAKE's bed, as a screen pixel */
      bedPx: (x, y) => pxOf(x, y, 0),
      /* a canvas pixel whose ray meets neither the bed's square nor any piece */
      airPx: () => {
        const v = M().getView(), r = rect(), rc = new THREE.Raycaster();
        const meshes = Object.keys(v.overviewMeshes).map(k => v.overviewMeshes[k]);
        for (let fy = 0.04; fy < 0.9; fy += 0.04) for (let fx = 0.3; fx < 0.7; fx += 0.04) {
          const x = r.left + fx * r.width, y = r.top + fy * r.height;
          rc.setFromCamera(new THREE.Vector2(fx * 2 - 1, -(fy * 2 - 1)), v.camera);
          const b = new THREE.Vector3();
          const onBed = rc.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), b) && Math.abs(b.x) <= 60 && Math.abs(b.z) <= 60;
          if (!onBed && !rc.intersectObjects(meshes, false).length && document.elementFromPoint(x, y) === v.renderer.domElement) return [x, y];
        }
        return null;
      },
      /* a canvas pixel that is empty: no piece, no line, not the bed */
      emptyPx: () => {
        const v = M().getView(), r = rect(), rc = new THREE.Raycaster();
        rc.params.Line.threshold = 2;
        const roots = [v.overviewGroup, v.detailGroup, v.highlightGroup];
        for (let fy = 0.95; fy > 0.3; fy -= 0.03) for (let fx = 0.55; fx < 0.97; fx += 0.03) {
          const x = r.left + fx * r.width, y = r.top + fy * r.height;
          rc.setFromCamera(new THREE.Vector2(fx * 2 - 1, -(fy * 2 - 1)), v.camera);
          if (!rc.intersectObjects(roots, true).length && document.elementFromPoint(x, y) === v.renderer.domElement) return [x, y];
        }
        return null;
      },
      pieces: () => M().takePieces(),
      status: () => document.getElementById('status').textContent
    };
  })();
  window.__dl = [];
  (function () {
    const orig = window.downloadBlob;
    window.downloadBlob = function (blob, name) { window.__dl.push({ name: name, size: blob.size, blob: blob }); };
    window.__dlRestore = function () { window.downloadBlob = orig; };
  })();
`;

const plate = page => page.evaluate(() => NSO_MICROSCOPE.plate());
const lensState = page => page.evaluate(() => window.__t.state('lens'));
const takeN = page => page.evaluate(() => NSO_MICROSCOPE.takePieces().length);

/* a real press-and-drag; leaves the button DOWN when `hold` */
async function drag(page, from, to, hold) {
  await page.mouse.move(from[0], from[1]);
  await page.mouse.down();
  await page.mouse.move((from[0] + to[0]) / 2, (from[1] + to[1]) / 2, { steps: 4 });
  await page.mouse.move(to[0], to[1], { steps: 5 });
  if (!hold) await page.mouse.up();
  await frames(page);
}

/* LENS shown, what we want selected selected; the button pressed is the real one */
async function showLens(page) {
  if (await plate(page) !== 'lens') { await page.click('#ms-plate-lens'); await frames(page); }
}

/* One whole pull, and what it must and must not do. Returns the piece. */
async function pull(page, label, select, pickSeg, to) {
  await showLens(page);
  await page.evaluate(select);
  await page.evaluate(() => NSO_MICROSCOPE.flushView());
  await frames(page);
  const before = await lensState(page);
  const n0 = await takeN(page);
  const sel = await page.evaluate(() => NSO_MICROSCOPE.selection().length);
  const from = await page.evaluate(pickSeg);
  await page.mouse.move(from[0], from[1]);
  await page.mouse.down();
  await page.mouse.move(from[0] + 25, from[1] + 18, { steps: 4 });
  const held = await page.evaluate(() => ({ plate: NSO_MICROSCOPE.plate(), grab: nsoGrab.active(), live: nsoGrab.live(), world: nsoGrab.world() && nsoGrab.world().name }));
  check(label + ': held, the view is TAKE and the piece is in hand', held.plate === 'take' && held.grab && held.live && held.world === 'take', J(held));
  await page.mouse.move(to[0], to[1], { steps: 6 });
  await page.mouse.up();
  await frames(page);
  const after = await page.evaluate(() => ({ plate: NSO_MICROSCOPE.plate(), n: NSO_MICROSCOPE.takePieces().length, grab: nsoGrab.active() }));
  check(label + ': dropped, the view stays on TAKE, one more piece', after.plate === 'take' && after.n === n0 + 1 && !after.grab, J(after) + ' from ' + sel + ' selected');
  const lens = await lensState(page);
  check(label + ': LENS is byte-identical', lens === before, lens === before ? JSON.parse(lens).coords + ' coordinates, selection ' + J(JSON.parse(lens).selection).slice(0, 40) : 'before ' + before + '\n after ' + lens);
  return after;
}

withApp(async (page, logs) => {
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.evaluate(PAGE_HELPERS);
  await loadSTL(page, BOX);
  await page.waitForTimeout(300);
  const placedAtStart = await page.evaluate(() => state.placed.length);

  /* The slice goes in through the app's own door: LENS is an import. */
  const bytes = Array.from(fs.readFileSync(SLICE));
  await page.evaluate(([b, n]) => NSO_MICROSCOPE.openFile(n, new Uint8Array(b).buffer), [bytes, 'gt.gcode.3mf']);
  await page.waitForFunction(() => NSO_MICROSCOPE.getDoc() && NSO_MICROSCOPE.getDoc().kind === 'toolpath', null, { timeout: 30000 });
  await frames(page);
  const shot = name => page.screenshot({ path: path.join(SHOTS, name + '.png') });

  /* ------------------------------------------------------------------ 1 */
  console.log('\n=== 1. the toggle ===');
  {
    const r = await page.evaluate(() => {
      const c = document.getElementById('ms-corner'), R = id => document.getElementById(id).getBoundingClientRect();
      return { kids: Array.from(c.children).map(e => e.id), text: Array.from(c.children).map(e => e.textContent.trim().toUpperCase()),
               seg: Array.from(document.getElementById('ms-plate-toggle').children).map(e => e.id),
               pressed: ['ms-plate-lens', 'ms-plate-take'].map(id => document.getElementById(id).getAttribute('aria-pressed')),
               x: ['ms-plate-lens', 'ms-plate-take', 'ms-btn-take-clear', 'ms-nav-export', 'ms-close'].map(id => Math.round(R(id).left)),
               y: ['ms-plate-lens', 'ms-plate-take', 'ms-btn-take-clear', 'ms-nav-export', 'ms-close'].map(id => Math.round(R(id).top)),
               W: innerWidth, closeR: R('ms-close').right, plate: NSO_MICROSCOPE.plate(), take: NSO_MICROSCOPE.takePieces().length };
    });
    check('the corner row is BACK . LENS|TAKE . CLEAR . EXPORT . CLOSE', J(r.kids) === J(['ms-btn-back-producer', 'ms-plate-toggle', 'ms-btn-take-clear', 'ms-nav-export', 'ms-close']) &&
      r.text[0] === 'BACK' && /^LENS\s*TAKE$/.test(r.text[1]) && J(r.text.slice(2)) === J(['CLEAR', 'EXPORT', 'CLOSE']), J(r.text));
    check('LENS | TAKE is a two-state toggle: two buttons, LENS lit to begin with', J(r.seg) === J(['ms-plate-lens', 'ms-plate-take']) && J(r.pressed) === J(['true', 'false']), J(r.pressed));
    check('...in one row, left to right, pinned top-right', r.x.every((x, i) => i === 0 || x > r.x[i - 1]) && r.y.every(y => Math.abs(y - r.y[0]) <= 1) && Math.abs(r.W - r.closeR - 8) < 1.5, J(r.x) + ' ' + J(r.y));
    check('LENS is shown, and TAKE is empty', r.plate === 'lens' && r.take === 0);

    // a round trip: TAKE, and back
    const before = await lensState(page);
    await page.click('#ms-plate-take');
    await frames(page);
    const t = await page.evaluate(() => ({ plate: NSO_MICROSCOPE.plate(), rows: document.querySelectorAll('#ms-legend .ms-legend-item').length,
      title: document.getElementById('ms-legend-title').textContent, zr: document.getElementById('ms-zr').hidden,
      sub: document.getElementById('ms-sub').textContent, info: document.getElementById('ms-info').textContent,
      pressed: ['ms-plate-lens', 'ms-plate-take'].map(id => document.getElementById(id).getAttribute('aria-pressed')),
      badge: document.getElementById('ms-mode-badge').textContent }));
    check('TAKE shown, empty: no legend rows, no slider, the header and the info say so', t.plate === 'take' && t.rows === 0 && t.zr && /TAKE/.test(t.sub) && /Nothing on TAKE/.test(t.info) && J(t.pressed) === J(['false', 'true']), J(t));
    await shot('01-take-empty');
    await page.click('#ms-plate-lens');
    await frames(page);
    check('and back: LENS is as it was', await lensState(page) === before && await plate(page) === 'lens');
    check('a toggle press that changes nothing changes nothing', await (async () => { await page.click('#ms-plate-lens'); return await lensState(page) === before; })());
  }

  /* ------------------------------------------------------------------ 2 */
  console.log('\n=== 2. five pulls ===');
  const toBed = [[-26, -22], [-6, -22], [14, -22], [-26, 0], [-6, 0]];
  const bedPx = (x, y) => page.evaluate(([x, y]) => window.__t.bedPx(x, y), [x, y]);
  // the TAKE camera, framed on its bed, is the same for every pull: where the bed's points land is read once it is up
  await page.click('#ms-plate-take');
  await frames(page);
  const dest = [];
  for (const [x, y] of toBed) dest.push(await bedPx(x, y));
  await page.click('#ms-plate-lens');
  await frames(page);

  // a. a capture-box region
  await pull(page, 'region (capture box)',
    () => { const M = NSO_MICROSCOPE; M.setMode('orbit'); M.clearBoxes(); M.addBoxAt(20, 10, 0.4, 6, 0.15); },
    () => window.__t.segPx(), dest[0]);
  // b. a picked line
  await pull(page, 'line (picked)',
    () => { const M = NSO_MICROSCOPE; M.clearBoxes(); const s = M.getDoc().segments.find(g => g.feature === 'Outer wall' && g.layer === 1); M.pickLine(s.mv.index); },
    () => window.__t.segPx(), dest[1]);
  // c. a layer
  await pull(page, 'layer',
    () => { const M = NSO_MICROSCOPE; M.clearBoxes(); M.selectLayer(2); },
    () => window.__t.segPx(sel => sel.find(s => s.feature === 'Outer wall') || sel[0]), dest[2]);
  // d. a feature from the legend
  await pull(page, 'feature (legend "only")',
    () => { const M = NSO_MICROSCOPE; M.clearBoxes(); M.showAll(); M.soloGroup('Support'); },
    () => window.__t.segPx(sel => sel.find(s => s.feature === 'Support')), dest[3]);

  // e. a whole piece: LENS is the plate, read with READ PLATE
  await showLens(page);
  await page.click('#ms-btn-plate');
  await page.waitForFunction(() => NSO_MICROSCOPE.getDoc() && NSO_MICROSCOPE.lensDoc().source === 'plate', null, { timeout: 30000 });
  await page.waitForFunction(() => NSO_MICROSCOPE.flange().status !== 'pending', null, { timeout: 30000 });
  await pull(page, 'piece (whole)',
    () => { const M = NSO_MICROSCOPE; M.clearBoxes(); M.selectObjects([M.getDoc().objects[0].name], 'pick'); },
    () => {
      // the box piece's top face, in the middle
      const M = NSO_MICROSCOPE, d = M.getDoc(), o = M.selection()[0], b = o.bounds;
      const v = M.getView(), p = new THREE.Vector3((b.minX + b.maxX) / 2 - d.cx, b.maxZ, -((b.minY + b.maxY) / 2 - d.cy)).project(v.camera);
      const r = v.renderer.domElement.getBoundingClientRect();
      return [r.left + (p.x + 1) / 2 * r.width, r.top + (1 - p.y) / 2 * r.height];
    }, dest[4]);
  {
    const names = await page.evaluate(() => NSO_MICROSCOPE.takePieces().map(p => p.name));
    check('TAKE has five pieces', names.length === 5, J(names));
    check('...each its own copy, named for what it was', new Set(names).size === 5, J(names));
    await shot('02-take-five');
  }

  /* ------------------------------------------------------------------ 3 */
  console.log('\n=== 3. Escape, a click, the box dots, the orbit ===');
  {
    await showLens(page);
    await page.evaluate(() => { const M = NSO_MICROSCOPE; M.setMode('orbit'); M.clearBoxes(); M.selectLayer(1); });
    // the LENS now is the plate (a box); a selection that has a line to press on is a piece
    await page.evaluate(() => { const M = NSO_MICROSCOPE; M.selectObjects([M.getDoc().objects[0].name], 'pick'); });
    const before = await lensState(page), n0 = await takeN(page);
    const from = await page.evaluate(() => {
      const M = NSO_MICROSCOPE, d = M.getDoc(), b = M.selection()[0].bounds, v = M.getView();
      const p = new THREE.Vector3((b.minX + b.maxX) / 2 - d.cx, b.maxZ, -((b.minY + b.maxY) / 2 - d.cy)).project(v.camera);
      const r = v.renderer.domElement.getBoundingClientRect();
      return [r.left + (p.x + 1) / 2 * r.width, r.top + (1 - p.y) / 2 * r.height];
    });
    await page.mouse.move(from[0], from[1]);
    await page.mouse.down();
    await page.mouse.move(from[0] + 40, from[1] + 30, { steps: 5 });
    const mid = await page.evaluate(() => ({ plate: NSO_MICROSCOPE.plate(), n: NSO_MICROSCOPE.takePieces().length, live: nsoGrab.live() }));
    check('mid-drag: TAKE is shown and a sixth piece is in hand', mid.plate === 'take' && mid.live && mid.n === n0 + 1, J(mid));
    await shot('03-mid-pull');
    await page.keyboard.press('Escape');
    await frames(page);
    const esc = await page.evaluate(() => ({ plate: NSO_MICROSCOPE.plate(), n: NSO_MICROSCOPE.takePieces().length, grab: nsoGrab.active(), open: NSO_MICROSCOPE.isOpen(), st: window.__t.status() }));
    check('Escape mid-drag: cancelled, back on LENS, nothing kept, G-scope still open', esc.plate === 'lens' && esc.n === n0 && !esc.grab && esc.open, J(esc));
    await page.mouse.move(from[0] + 80, from[1] + 50, { steps: 3 });
    await page.mouse.up();
    await frames(page);
    check('...and letting go afterwards does nothing more', await plate(page) === 'lens' && await takeN(page) === n0);
    check('LENS is byte-identical after the cancelled pull', await lensState(page) === before);

    // a press that never travels is a click
    await page.mouse.move(from[0], from[1]);
    await page.mouse.down();
    await page.mouse.up();
    await frames(page);
    check('a press that does not travel pulls nothing', await plate(page) === 'lens' && await takeN(page) === n0 && await lensState(page) === before);

    // a press on empty space still orbits
    const empty = await page.evaluate(() => window.__t.emptyPx());
    const camBefore = await page.evaluate(() => JSON.stringify(NSO_MICROSCOPE.getView().camera.position.toArray().map(v => +v.toFixed(3))));
    await drag(page, empty, [empty[0] - 80, empty[1] - 30]);
    const camAfter = await page.evaluate(() => JSON.stringify(NSO_MICROSCOPE.getView().camera.position.toArray().map(v => +v.toFixed(3))));
    check('a press on empty space orbits, and pulls nothing', camBefore !== camAfter && await plate(page) === 'lens' && await takeN(page) === n0, camBefore + ' -> ' + camAfter);

    // a capture box's dots keep their press
    await page.evaluate(() => { const M = NSO_MICROSCOPE; M.setMode('select'); M.clearBoxes(); const o = M.getDoc().objects[0]; const b = o.bounds;
      M.addBoxAt((b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2, (b.minZ + b.maxZ) / 2, 14, 14); });
    const dot = await page.evaluate(() => {
      const M = NSO_MICROSCOPE, v = M.getView(), r = v.renderer.domElement.getBoundingClientRect();
      const bx = M.boxes()[0], p = M.toView(bx.gx, bx.gy, bx.gz).project(v.camera);
      return { px: [r.left + (p.x + 1) / 2 * r.width, r.top + (1 - p.y) / 2 * r.height], at: [bx.gx, bx.gy, bx.gz] };
    });
    check('a box over a piece selects it', await page.evaluate(() => NSO_MICROSCOPE.selection().length) === 1);
    await drag(page, dot.px, [dot.px[0] + 50, dot.px[1] + 20]);
    const moved = await page.evaluate(() => ({ plate: NSO_MICROSCOPE.plate(), at: (b => [b.gx, b.gy, b.gz])(NSO_MICROSCOPE.boxes()[0]), n: NSO_MICROSCOPE.takePieces().length }));
    const dist = Math.hypot(moved.at[0] - dot.at[0], moved.at[1] - dot.at[1], moved.at[2] - dot.at[2]);
    check('pressing the box\'s centre dot moves the box - it does not pull', moved.plate === 'lens' && dist > 2 && moved.n === n0, J(moved) + ' moved ' + dist.toFixed(1) + ' mm');
    // ...and so does its face, in front of the selection, while region is armed: it scales the footprint
    const face = await page.evaluate(() => {
      const M = NSO_MICROSCOPE, v = M.getView(), r = v.renderer.domElement.getBoundingClientRect(), b = M.boxes()[0];
      const p = M.toView(b.gx + b.ex, b.gy, b.gz + b.h).project(v.camera);      // on the box's top edge, over the +X side
      return { px: [r.left + (p.x + 1) / 2 * r.width, r.top + (1 - p.y) / 2 * r.height - 2], rx: b.rx };
    });
    await drag(page, face.px, [face.px[0] + 40, face.px[1] - 10]);
    const scaled = await page.evaluate(() => ({ plate: NSO_MICROSCOPE.plate(), rx: NSO_MICROSCOPE.boxes()[0].rx, n: NSO_MICROSCOPE.takePieces().length }));
    check('pressing the box\'s face while region is armed scales it - it does not pull', scaled.plate === 'lens' && scaled.n === n0 && Math.abs(scaled.rx - face.rx) > 0.5, J(scaled) + ' from rx ' + face.rx);
    await page.evaluate(() => { const M = NSO_MICROSCOPE; M.clearBoxes(); M.setMode('orbit'); });
  }

  /* ------------------------------------------------------------------ 4 */
  console.log('\n=== 4. TAKE follows: legend, readouts, slider ===');
  {
    await page.click('#ms-plate-take');
    await frames(page);
    const t = await page.evaluate(() => {
      const M = NSO_MICROSCOPE, d = M.getDoc(), z = document.getElementById('ms-zr');
      return { plate: M.plate(), rows: Array.from(document.querySelectorAll('#ms-legend .ms-legend-item .ms-legend-label')).map(e => e.textContent),
        title: document.getElementById('ms-legend-title').textContent, sub: document.getElementById('ms-sub').textContent,
        zrHidden: z.hidden, zrCount: document.getElementById('ms-zr-count').textContent, zr: M.zRange(), kind: d.kind, source: d.source,
        det: document.getElementById('ms-detected').children.length, info: document.getElementById('ms-info').textContent,
        badge: document.getElementById('ms-mode-badge').textContent, lens: M.lensDoc().name };
    });
    check('the legend lists the five pieces, as Parts', t.rows.length === 5 && t.title === 'Parts', J(t.rows));
    check('the header is TAKE\'s: five pieces', /^TAKE - 5 pieces/.test(t.sub), t.sub.slice(0, 60));
    check('the slider is TAKE\'s: a Z range over what is on it', !t.zrHidden && t.zr && t.zr.bandMm[1] > 5 && t.zr.unit === 'mm', J(t.zr));
    check('the detector rows are not on TAKE; the badge says TAKE', t.det === 0 && /TAKE: 5/.test(t.badge), t.badge);
    check('getDoc() is the plate shown; lensDoc() is still LENS\'s', t.kind === 'mesh' && t.source === 'take' && t.lens === 'Plate');
    // the slider clips TAKE like any mesh: the lower half only
    const clipped = await page.evaluate(() => { const M = NSO_MICROSCOPE; M.setZRangeMm(0, 1); M.flushView(); return [M.zRange().bandMm, M.shownCount()]; });
    check('the slider narrows TAKE to a band', clipped[0][1] < 3 && clipped[1] >= 1, J(clipped));
    await page.evaluate(() => { NSO_MICROSCOPE.setZRange(0, 1e6); NSO_MICROSCOPE.flushView(); });
    await shot('04-take-follows');
    // and the legend's own row toggles a piece off and back
    const dim = await page.evaluate(() => { const row = () => document.querySelector('#ms-legend .ms-legend-item');
      row().click(); const a = row().classList.contains('dim'); row().click(); return [a, row().classList.contains('dim')]; });
    check('a legend row hides a piece and shows it again', dim[0] === true && dim[1] === false, J(dim));
  }

  /* ------------------------------------------------------------------ 5 */
  console.log('\n=== 5. pieces on TAKE: grab and drop ===');
  let layerPiece, boxPiece;
  {
    await page.evaluate(() => { NSO_MICROSCOPE.showAll(); NSO_MICROSCOPE.setMode('orbit'); NSO_MICROSCOPE.clearBoxes(); });
    const names = await page.evaluate(() => NSO_MICROSCOPE.takePieces().map(p => p.name));
    boxPiece = names[4]; layerPiece = names[2];
    const info = n => page.evaluate(n => { const p = NSO_MICROSCOPE.takePieces().find(x => x.name === n); return p ? { b: p.bounds, tri: p.triangles } : null; }, n);
    // onto the bed: pressed on the layer piece, let go over an empty stretch of bed
    const b0 = (await info(layerPiece)).b;
    const from = await page.evaluate(n => window.__t.piecePx(n, 0), layerPiece);
    const toBedPt = await bedPx(30, 30);
    await drag(page, from, toBedPt, true);
    const live = await page.evaluate(() => ({ g: nsoGrab.active(), mode: nsoGrab.mode(), w: nsoGrab.world() && nsoGrab.world().name, st: window.__t.status() }));
    check('pressed on a TAKE piece and carried: the main plate\'s grab, in TAKE\'s world', live.g && live.w === 'take' && live.mode === 'plate' && /Over the plate - let go to set/.test(live.st), J(live));
    await page.mouse.up();
    await frames(page);
    const b1 = (await info(layerPiece)).b;
    const st = await page.evaluate(() => ({ s: window.__t.status(), p: NSO_MICROSCOPE.plate(), sel: NSO_MICROSCOPE.selection().map(o => o.name) }));
    check('let go over the bed: set down there, on the bed (lowest point 0)', Math.abs(b1.minZ) < 1e-3 && (Math.abs(b1.minX - b0.minX) > 5 || Math.abs(b1.minY - b0.minY) > 5) && /set down on the TAKE plate/.test(st.s), J([b0.minX, b0.minY, '->', b1.minX, b1.minY, b1.minZ]));
    check('...and it is the selection, still on TAKE', st.p === 'take' && st.sel.length === 1 && st.sel[0] === layerPiece);
    await shot('05-set-down');

    // onto another piece: seated at the Seat gap
    const gap = await page.evaluate(() => readSeatGapInput());
    const fromL = await page.evaluate(n => window.__t.piecePx(n, 0), layerPiece);
    const top = await page.evaluate(n => window.__t.topPx(n), boxPiece);
    await drag(page, fromL, top, true);
    const over = await page.evaluate(() => ({ mode: nsoGrab.mode(), over: nsoGrab.over(), st: window.__t.status(), box: !!nsoGrab.layer() && nsoGrab.layer().children.length }));
    check('over another piece: "let go to seat", the target boxed', over.mode === 'piece' && over.over === boxPiece && /let go to seat/.test(over.st) && over.box >= 2, J(over));
    await page.mouse.up();
    await frames(page);
    const b2 = (await info(layerPiece)).b, tb = (await info(boxPiece)).b;
    const st2 = await page.evaluate(() => window.__t.status());
    const cx = (b2.minX + b2.maxX) / 2 - (tb.minX + tb.maxX) / 2, cy = (b2.minY + b2.maxY) / 2 - (tb.minY + tb.maxY) / 2;
    check('let go: seated onto it, outside its top face at the Seat gap, over the point let go at', /Dropped onto .* seated/.test(st2) && Math.abs(b2.minZ - (tb.maxZ - gap)) < 0.05 && Math.hypot(cx, cy) < 12, J([b2.minZ, tb.maxZ, gap, Math.hypot(cx, cy), st2.slice(0, 90)]));
    await shot('06-seated');

    // into the air
    const air = await page.evaluate(() => window.__t.airPx());
    check('there is a patch of canvas over nothing', !!air);
    const fromA = await page.evaluate(n => window.__t.piecePx(n, 0), layerPiece);
    await drag(page, fromA, air, true);
    check('over nothing: "let go to leave it in the air"', await page.evaluate(() => nsoGrab.mode() === 'air' && /in the air where it is/.test(window.__t.status())));
    await page.mouse.up();
    await frames(page);
    const b3 = (await info(layerPiece)).b;
    check('let go: left in the air, over the bed', b3.minZ > 1 && /left in the air/.test(await page.evaluate(() => window.__t.status())), 'minZ ' + b3.minZ.toFixed(2));
    // still grabbable
    const fromG = await page.evaluate(n => window.__t.piecePx(n, 0), layerPiece);
    await drag(page, fromG, await bedPx(30, -30));
    const b4 = (await info(layerPiece)).b;
    check('a piece in the air is still grabbable, and comes down on the bed', Math.abs(b4.minZ) < 1e-3, 'minZ ' + b4.minZ);

    // Escape puts it back
    const bE = (await info(layerPiece)).b;
    const fromE = await page.evaluate(n => window.__t.piecePx(n, 0), layerPiece);
    await drag(page, fromE, await bedPx(30, -30), true);
    await page.keyboard.press('Escape');
    await page.mouse.up();
    await frames(page);
    const bE2 = (await info(layerPiece)).b;
    check('Escape mid-drag: put back exactly, still on TAKE, G-scope open', J(bE) === J(bE2) && await plate(page) === 'take' && await page.evaluate(() => NSO_MICROSCOPE.isOpen()), J([bE.minX, bE2.minX]));

    // a click on a piece does not move it
    const fromC = await page.evaluate(n => window.__t.piecePx(n, 0), layerPiece);
    await page.mouse.click(fromC[0], fromC[1]);
    await frames(page);
    check('a click on a piece moves nothing and selects it', J((await info(layerPiece)).b) === J(bE) &&
      await page.evaluate(n => NSO_MICROSCOPE.selection().length === 1 && NSO_MICROSCOPE.selection()[0].name === n, layerPiece));

    // each pull was a copy: LENS (the plate) still has its piece and the plate its own
    check('each pull was a copy: LENS and the main plate are as they were',
      await page.evaluate(() => NSO_MICROSCOPE.lensDoc().objects.length === 1 && state.placed.length) === placedAtStart);
    const refused = await page.evaluate(() => nsoGrab.active());
    check('nothing is left in hand', refused === false);
  }

  /* ------------------------------------------------------------------ 6 */
  console.log('\n=== 6. export: the whole plate, the selected piece ===');
  {
    // the selected piece: a slice's beads, as lines and as solid. The Selected piece group shows on TAKE.
    const sliced = await page.evaluate(() => NSO_MICROSCOPE.takePieces().filter(p => p.moves > 0).map(p => p.name));
    check('the pieces pulled off the slice kept their beads; the plate piece did not', sliced.length === 4, J(sliced));
    await page.evaluate(n => NSO_MICROSCOPE.selectObjects([n], 'pick'), sliced[0]);
    await page.click('#ms-nav-export');
    const g = await page.evaluate(() => Array.from(document.querySelectorAll('#ms-card-export .ms-xgroup')).map(x => ({
      t: x.querySelector('.ms-section-title').textContent.trim(), shown: getComputedStyle(x).display !== 'none' && x.getBoundingClientRect().height > 0,
      btns: Array.from(x.querySelectorAll('button')).filter(b => b.getBoundingClientRect().width > 0).map(b => b.id) })));
    check('Export on TAKE: "Selected piece" (to plate / STL, lines and solid) and "Whole plate" (to plate / STL); not "Sliced piece"',
      g[0].t === 'Selected piece' && g[0].shown && g[0].btns.length === 4 && !g[1].shown && g[2].t === 'Whole plate' && g[2].shown && g[2].btns.length === 2, J(g));
    await shot('07-export-take');
    await page.click('#ms-nav-export');

    // selected piece, as STL: lines, then solid
    await page.evaluate(() => { window.__dl.length = 0; });
    const tris = await page.evaluate(n => NSO_MICROSCOPE.takePieces().find(p => p.name === n).triangles, sliced[0]);
    await page.click('#ms-btn-export-stl');
    const dl1 = await page.evaluate(() => window.__dl.map(d => [d.name, d.size]));
    check('Selected piece as STL (lines): its prisms, 12 triangles a move', dl1.length === 1 && dl1[0][1] === 84 + tris * 50 && tris % 12 === 0, J(dl1) + ' ' + tris + ' tris');
    await page.click('#ms-btn-export-solid-stl');
    await page.waitForFunction(() => window.__dl.length === 2, null, { timeout: 60000 });
    const dl2 = await page.evaluate(() => window.__dl.map(d => [d.name, d.size]));
    check('Selected piece as STL (solid): the swept shells', /solid/.test(dl2[1][0]) && dl2[1][1] > 84 && dl2[1][1] !== dl1[0][1], J(dl2));

    // a plate piece has no beads: no solid
    await page.evaluate(n => NSO_MICROSCOPE.selectObjects([n], 'pick'), boxPiece);
    const solidShown = await page.evaluate(() => getComputedStyle(document.getElementById('ms-export-solid-row')).display);
    check('a piece that is a mesh has no "as solid"', solidShown === 'none', solidShown);

    // selected piece onto the main plate, lines and solid: each one placed piece, one Undo
    await page.evaluate(n => NSO_MICROSCOPE.selectObjects([n], 'pick'), sliced[1]);
    let before = await page.evaluate(() => ({ placed: state.placed.length, undo: state.undoStack.length }));
    await page.click('#ms-btn-export-plate');
    await frames(page);
    let after = await page.evaluate(() => ({ placed: state.placed.length, undo: state.undoStack.length, open: NSO_MICROSCOPE.isOpen(), name: state.placed[state.placed.length - 1].name }));
    check('Selected piece -> main plate (lines): one placed piece, one Undo, G-scope closes', after.placed === before.placed + 1 && after.undo === before.undo + 1 && !after.open && after.name === sliced[1], J(after));

    await page.click('#btn-microscope');
    await page.waitForFunction(() => NSO_MICROSCOPE.isOpen(), null, { timeout: 30000 });
    await frames(page);
    check('G-scope opened from the main plate: on LENS, TAKE\'s five still there', await plate(page) === 'lens' && await takeN(page) === 5);
    await page.click('#ms-plate-take');
    await page.evaluate(n => NSO_MICROSCOPE.selectObjects([n], 'pick'), sliced[2]);
    before = await page.evaluate(() => ({ placed: state.placed.length, undo: state.undoStack.length }));
    await page.click('#ms-btn-export-solid-plate');
    await page.waitForFunction(n => state.placed.length === n, before.placed + 1, { timeout: 60000 });
    after = await page.evaluate(() => ({ placed: state.placed.length, undo: state.undoStack.length, name: state.placed[state.placed.length - 1].name }));
    check('Selected piece -> main plate (solid): one placed piece "(solid)", one Undo', after.undo === before.undo + 1 && /\(solid\)$/.test(after.name), J(after));

    // the whole plate, as STL and onto the main plate
    await page.click('#btn-microscope').catch(() => {});
    if (!(await page.evaluate(() => NSO_MICROSCOPE.isOpen()))) {
      await page.click('#btn-microscope');
      await page.waitForFunction(() => NSO_MICROSCOPE.isOpen(), null, { timeout: 30000 });
    }
    await page.click('#ms-plate-take');
    await frames(page);
    await page.evaluate(() => { window.__dl.length = 0; });
    await page.click('#ms-nav-export');
    await page.click('#ms-btn-take-export-stl');
    const wd = await page.evaluate(() => ({ dl: window.__dl.map(d => [d.name, d.size]), tri: NSO_MICROSCOPE.takePieces().reduce((a, p) => a + p.triangles, 0) }));
    check('Whole plate as STL: one file with every piece\'s triangles', wd.dl.length === 1 && wd.dl[0][1] === 84 + wd.tri * 50, J(wd));
    before = await page.evaluate(() => ({ placed: state.placed.length, undo: state.undoStack.length }));
    await page.click('#ms-btn-take-export-plate');
    await frames(page);
    after = await page.evaluate(() => ({ placed: state.placed.length, undo: state.undoStack.length, open: NSO_MICROSCOPE.isOpen(), names: state.placed.slice(-5).map(p => p.name) }));
    check('Whole plate -> main plate: five placed pieces, one Undo, G-scope closes', after.placed === before.placed + 5 && after.undo === before.undo + 1 && !after.open, J(after));
    check('...each named for its piece', new Set(after.names).size === 5, J(after.names));
    await page.keyboard.press('Control+z');
    await page.waitForTimeout(300);
    check('...and that one Undo takes all five back', await page.evaluate(() => state.placed.length) === before.placed, String(await page.evaluate(() => state.placed.length)));

    // On LENS: today's selection exports, unchanged
    await page.click('#btn-microscope');
    await page.waitForFunction(() => NSO_MICROSCOPE.isOpen(), null, { timeout: 30000 });
    await page.waitForFunction(() => NSO_MICROSCOPE.lensDoc() && NSO_MICROSCOPE.flange().status !== 'pending', null, { timeout: 30000 });
    await frames(page);
    await showLens(page);
    await page.evaluate(() => { const M = NSO_MICROSCOPE; M.selectObjects([M.getDoc().objects[0].name], 'pick'); });
    await page.click('#ms-nav-export');
    const lg = await page.evaluate(() => Array.from(document.querySelectorAll('#ms-card-export .ms-xgroup')).map(x => ({
      t: x.querySelector('.ms-section-title').textContent.trim(), shown: getComputedStyle(x).display !== 'none' && x.getBoundingClientRect().height > 0 })));
    check('on LENS the Export card is today\'s: "Selection" shows, no "Whole plate"', lg[0].t === 'Selection' && lg[0].shown && !lg[2].shown, J(lg));
    before = await page.evaluate(() => state.placed.length);
    await page.click('#ms-btn-export-plate');
    await frames(page);
    check('...and Export to plate puts the selection on the plate as it always did', await page.evaluate(() => state.placed.length) === before + 1);
  }

  /* ------------------------------------------------------------------ 7 */
  console.log('\n=== 7. CLEAR, and opening from the main plate ===');
  {
    // LENS an import, TAKE with something on it
    await page.evaluate(([b, n]) => { NSO_MICROSCOPE.close(); NSO_MICROSCOPE.openFile(n, new Uint8Array(b).buffer); }, [bytes, 'gt.gcode.3mf']);
    await page.waitForFunction(() => NSO_MICROSCOPE.isOpen() && NSO_MICROSCOPE.lensDoc() && NSO_MICROSCOPE.lensDoc().kind === 'toolpath', null, { timeout: 30000 });
    await frames(page);
    const n0 = await takeN(page);
    check('TAKE kept its pieces through an export, a close and an import', n0 === 5, String(n0));
    await page.click('#ms-plate-take');
    await frames(page);
    check('TAKE is shown (and a load went to LENS, not TAKE)', await plate(page) === 'take' && await page.evaluate(() => NSO_MICROSCOPE.lensDoc().kind) === 'toolpath');
    await page.evaluate(() => NSO_MICROSCOPE.close());
    await page.click('#btn-microscope');
    await page.waitForFunction(() => NSO_MICROSCOPE.isOpen(), null, { timeout: 30000 });
    await frames(page);
    check('opened from the main plate: on LENS, and the imported file stays until CLEAR',
      await plate(page) === 'lens' && await page.evaluate(() => NSO_MICROSCOPE.getDoc().name) === 'gt.gcode.3mf');

    // plain CLEAR: TAKE empty, LENS (the import) untouched
    const lensBefore = await lensState(page);
    await page.click('#ms-plate-take');
    await page.click('#ms-btn-take-clear');
    await frames(page);
    const c = await page.evaluate(() => ({ n: NSO_MICROSCOPE.takePieces().length, rows: document.querySelectorAll('#ms-legend .ms-legend-item').length,
      plate: NSO_MICROSCOPE.plate(), info: document.getElementById('ms-info').textContent, lens: NSO_MICROSCOPE.lensDoc().name }));
    check('CLEAR empties TAKE (still shown, now empty); its legend is empty', c.n === 0 && c.rows === 0 && c.plate === 'take' && /Nothing on TAKE/.test(c.info), J(c));
    check('...and LENS, the import, is untouched', c.lens === 'gt.gcode.3mf' && await (async () => { await page.click('#ms-plate-lens'); return await lensState(page) === lensBefore; })());

    // Shift-CLEAR: also LENS back to the plate
    await page.evaluate(() => { const M = NSO_MICROSCOPE; M.showPlate('lens'); M.selectLayer(1); });
    const from = await page.evaluate(() => window.__t.segPx());
    await drag(page, from, await bedPx(0, 0));
    check('one piece pulled again', await takeN(page) === 1);
    await page.click('#ms-btn-take-clear', { modifiers: ['Shift'] });
    await page.waitForFunction(() => NSO_MICROSCOPE.lensDoc() && NSO_MICROSCOPE.lensDoc().source === 'plate', null, { timeout: 30000 });
    await frames(page);
    const s = await page.evaluate(() => ({ n: NSO_MICROSCOPE.takePieces().length, lens: NSO_MICROSCOPE.lensDoc().source, plate: NSO_MICROSCOPE.plate(), objs: NSO_MICROSCOPE.lensDoc().objects.length, placed: state.placed.length }));
    check('Shift-CLEAR: TAKE empty, the import dropped, the plate read again into LENS, LENS shown', s.n === 0 && s.lens === 'plate' && s.plate === 'lens' && s.objs === s.placed, J(s));

    // reopening from the main plate re-reads it
    await page.evaluate(() => NSO_MICROSCOPE.close());
    await loadSTL(page, BOX);
    await page.click('#btn-microscope');
    await page.waitForFunction(() => NSO_MICROSCOPE.isOpen(), null, { timeout: 30000 });
    await frames(page);
    const re = await page.evaluate(() => ({ objs: NSO_MICROSCOPE.lensDoc().objects.length, placed: state.placed.length }));
    check('opening G-scope from the main plate always reads the plate again into LENS', re.objs === re.placed && re.objs >= 2, J(re));
  }

  /* ------------------------------------------------------------------ 8 */
  console.log('\n=== 8. no exit on a double-click ===');
  {
    for (const which of ['lens', 'take']) {
      await page.evaluate(w => NSO_MICROSCOPE.showPlate(w), which);
      await frames(page);
      await page.evaluate(() => NSO_MICROSCOPE.setMode('select'));
      const pt = await page.evaluate(() => window.__t.emptyPx());
      const st0 = await page.evaluate(() => window.__t.state(NSO_MICROSCOPE.plate()));
      await page.mouse.dblclick(pt[0], pt[1]);
      await page.waitForTimeout(150);
      await page.mouse.dblclick(pt[0], pt[1]);
      await page.waitForTimeout(150);
      const r = await page.evaluate(() => ({ open: NSO_MICROSCOPE.isOpen(), mode: NSO_MICROSCOPE.mode(), plate: NSO_MICROSCOPE.plate() }));
      check('a double-click on the view (' + which.toUpperCase() + ', region armed) does nothing: still open, still armed, same plate',
        r.open && r.mode === 'select' && r.plate === which && (await page.evaluate(() => window.__t.state(NSO_MICROSCOPE.plate()))) === st0, J(r));
      await page.evaluate(() => NSO_MICROSCOPE.setMode('orbit'));
    }
    await page.click('#ms-close');
    await page.waitForTimeout(150);
    check('Close is an exit', await page.evaluate(() => !NSO_MICROSCOPE.isOpen()));
  }

  /* ------------------------------------------------------------------ 9 */
  console.log('\n=== 9. Watch\'s log docks bottom-right, under the slider\'s All button ===');
  {
    await page.click('#btn-microscope');
    await page.waitForFunction(() => NSO_MICROSCOPE.isOpen(), null, { timeout: 30000 });
    await page.evaluate(() => NSO_MICROSCOPE.showPlate('lens'));
    await frames(page);
    const w0 = await page.evaluate(() => ({ zr: !document.getElementById('ms-zr').hidden, on: !!document.getElementById('nso-watch-panel') && document.getElementById('nso-watch-panel').classList.contains('is-on') }));
    if (!w0.on) await page.evaluate(() => document.getElementById('btn-watch').click());
    await page.waitForFunction(() => { const p = document.getElementById('nso-watch-panel'); return p && p.classList.contains('is-on') && p.classList.contains('in-gscope'); }, null, { timeout: 10000 });
    await page.waitForTimeout(250);
    await frames(page);
    const g = await page.evaluate(() => {
      const R = id => { const e = document.getElementById(id), b = e.getBoundingClientRect(); return { x: b.left, y: b.top, r: b.right, b: b.bottom, w: b.width, h: b.height }; };
      const ro = R('ms-readouts'), zr = document.getElementById('ms-zr').hidden ? null : R('ms-zr');
      return { panel: R('nso-watch-panel'), all: R('ms-zr-all'), zr, ro, leg: R('ms-dock-left'), W: innerWidth, H: innerHeight,
               corner: R('ms-corner'), roKids: Array.from(document.getElementById('ms-readouts').children).filter(e => e.getBoundingClientRect().width > 0).map(e => e.getBoundingClientRect()).map(b => ({ r: b.right, b: b.bottom })) };
    });
    check('the log is in the bottom-right corner of the view', g.panel.r > g.W - 16 && g.panel.r <= g.W - 8 && g.panel.b > g.H - 16 && g.panel.b <= g.H - 8, J([g.panel.r, g.panel.b, g.W, g.H]));
    check('...under the slider\'s All button: below it, the slider shortened to make room', g.zr && g.panel.y >= g.all.b - 0.5 && g.zr.b <= g.panel.y, J([g.all.b, g.panel.y, g.zr && g.zr.b]));
    check('...clear of the slider, the readouts and the legend', g.panel.x >= g.roKids.reduce((a, k) => Math.max(a, k.r), 0) - 0.5 && g.panel.x >= g.leg.x + g.leg.w, J([g.panel.x, g.roKids.map(k => Math.round(k.r))]));
    check('...and clear of the corner row', g.panel.y >= g.corner.b, J([g.panel.y, g.corner.b]));
    await shot('08-watch-dock');
    // collapsed: the slider takes the room back
    await page.evaluate(() => document.getElementById('nso-watch-collapse').click());
    await page.waitForTimeout(200);
    const c = await page.evaluate(() => ({ h: document.getElementById('nso-watch-panel').getBoundingClientRect().height, zb: document.getElementById('ms-zr').getBoundingClientRect().bottom, all: document.getElementById('ms-zr-all').getBoundingClientRect().bottom, py: document.getElementById('nso-watch-panel').getBoundingClientRect().top }));
    check('collapsed to its bar, it still sits under the All button', c.py >= c.all - 0.5, J(c));
    await page.evaluate(() => document.getElementById('nso-watch-collapse').click());
    await page.evaluate(() => document.getElementById('btn-watch').click());
    await page.waitForTimeout(200);
    const off = await page.evaluate(() => getComputedStyle(document.getElementById('ms-viewport')).getPropertyValue('--ms-watch-h'));
    check('Watch off: the slider has its room back', off.trim() === '', JSON.stringify(off));
  }

  const errs = logs.filter(l => /^\[pageerror\]/.test(l) || /^\[error\]/.test(l)).filter(l => !/Failed to load resource/.test(l));
  check('no page errors', errs.length === 0, errs.slice(0, 3).join(' | ') || 'none');
  console.log(fails ? '\n' + fails + ' FAILED' : '\nall gates held');
  process.exit(fails ? 1 : 0);
}).catch(e => { console.error('TEST CRASH', e); process.exit(1); });
