#!/usr/bin/env node
/* Measure — does the number on screen match the piece?
   node tools/nso_measure_test.js          exit 0 = every gate held

   Two halves, on purpose:

   PART A is the geometry on its own, against fixtures on disk. Every fixture
   here has a size that is known before the tool runs - it is in the file's own
   name or in its bounding box - so "20.000 mm" is checked against 20, not
   against whatever the tool said last week. Every edge of every box is
   measured, not a sampled one, because a tool that gets eleven edges right and
   the twelfth wrong is a tool that is wrong.

   PART B is the real app in Chromium: the real button, real clicks at real
   screen coordinates on a real STL, read back through the real readout. A
   click is aimed by projecting a known world point through the app's own
   camera, so the number the tool reports is checked against the piece's own
   bounding box - measured by three.js, not by anything in app-measure.js.

   The two halves answer different questions. A passes if the maths is right.
   B passes if the maths is also what a click actually reaches. */

const path = require('path');
const M = require('../app-measure.js');
const { readSTL } = require('./nso_stl_io');
const { withApp, loadSTL, selectModel, openMenuFor, ROOT } = require('./nso_app_harness');

const fx = f => path.join(ROOT, 'fixtures', f);

let fails = 0;
function check(name, cond, detail) {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail ? '   ' + detail : ''));
  if (!cond) fails++;
}
// Ground truth is exact here: these fixtures are axis-aligned boxes written
// as float32, so anything past the float32 rounding is a real error.
const near = (a, b, tol) => Math.abs(a - b) <= (tol == null ? 1e-3 : tol);
const f3 = v => (Math.round(v * 1000) / 1000).toFixed(3);

function bbox(soup) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < soup.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      if (soup[i + k] < lo[k]) lo[k] = soup[i + k];
      if (soup[i + k] > hi[k]) hi[k] = soup[i + k];
    }
  }
  return { lo, hi, size: [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]] };
}

/* Every feature edge of a soup, measured end to end, as a sorted list of
   distinct lengths with how many chains landed on each. */
function chainHistogram(soup) {
  const topo = M.markFeatureEdges(M.buildTopology(soup));
  const hist = new Map();
  let chains = 0;
  for (let i = 0; i < topo.edges.length; i++) {
    if (!topo.edges[i].feature) continue;
    const c = M.edgeChain(topo, i);
    if (!c) continue;
    chains++;
    const k = f3(c.length);
    hist.set(k, (hist.get(k) || 0) + 1);
  }
  return { hist, chains, topo };
}

/* A closed box whose faces are cut into `nx` columns along X, so each edge
   that runs along X is nx separate mesh edges. The chain walk has to add them
   back up: a mesher's triangulation is not a dimension. */
function subdividedBox(w, d, h, nx) {
  const tris = [];
  const quad = (a, b, c, e) => tris.push(a, b, c, a, c, e);
  const x = i => -w / 2 + (w * i) / nx;
  for (let i = 0; i < nx; i++) {
    const x0 = x(i), x1 = x(i + 1);
    // bottom (-Y) and top (+Y)
    quad([x0, -h / 2, -d / 2], [x1, -h / 2, -d / 2], [x1, -h / 2, d / 2], [x0, -h / 2, d / 2]);
    quad([x0, h / 2, d / 2], [x1, h / 2, d / 2], [x1, h / 2, -d / 2], [x0, h / 2, -d / 2]);
    // front (+Z) and back (-Z)
    quad([x0, -h / 2, d / 2], [x1, -h / 2, d / 2], [x1, h / 2, d / 2], [x0, h / 2, d / 2]);
    quad([x1, -h / 2, -d / 2], [x0, -h / 2, -d / 2], [x0, h / 2, -d / 2], [x1, h / 2, -d / 2]);
  }
  // the two ends, one quad each
  quad([w / 2, -h / 2, -d / 2], [w / 2, -h / 2, d / 2], [w / 2, h / 2, d / 2], [w / 2, h / 2, -d / 2]);
  quad([-w / 2, -h / 2, d / 2], [-w / 2, -h / 2, -d / 2], [-w / 2, h / 2, -d / 2], [-w / 2, h / 2, d / 2]);
  const soup = new Float32Array(tris.length * 3);
  for (let i = 0; i < tris.length; i++) {
    soup[i * 3] = tris[i][0]; soup[i * 3 + 1] = tris[i][1]; soup[i * 3 + 2] = tris[i][2];
  }
  return soup;
}

function partA() {
  console.log('\n=== A1. a 20 mm cube: every edge is 20 mm, and the face diagonal is not an edge ===');
  const cube = readSTL(fx('box-20mm.stl'));
  const cb = bbox(cube);
  check('fixture really is 20 x 20 x 20', cb.size.every(s => near(s, 20)), cb.size.map(f3).join(' x '));
  const a1 = chainHistogram(cube);
  check('8 welded corners, 18 mesh edges', a1.topo.verts.length === 8 && a1.topo.edges.length === 18,
        a1.topo.verts.length + ' verts, ' + a1.topo.edges.length + ' edges');
  check('12 of them are edges you can see (the 6 face diagonals are not)',
        a1.chains === 12, a1.chains + ' feature edges');
  check('every one measures 20.000',
        a1.hist.size === 1 && a1.hist.get('20.000') === 12,
        JSON.stringify(Object.fromEntries(a1.hist)));

  console.log('\n=== A2. corner to corner across that cube ===');
  const c = [
    [cb.lo[0], cb.lo[1], cb.lo[2]], [cb.hi[0], cb.hi[1], cb.hi[2]],
    [cb.hi[0], cb.hi[1], cb.lo[2]]
  ];
  const body = M.span(c[0], c[1]), diag = M.span(c[0], c[2]);
  check('body diagonal = 20*sqrt(3) = 34.641', near(body.length, 20 * Math.sqrt(3)), f3(body.length));
  check('face diagonal = 20*sqrt(2) = 28.284', near(diag.length, 20 * Math.sqrt(2)), f3(diag.length));
  check('per-axis deltas come back with it', near(body.dx, 20) && near(body.dy, 20) && near(body.dz, 20),
        'dX ' + f3(body.dx) + ' dY ' + f3(body.dy) + ' dZ ' + f3(body.dz));

  console.log('\n=== A3. a click near a corner IS that corner ===');
  const topo = M.markFeatureEdges(M.buildTopology(cube));
  const off = M.snapPoint(topo, [9.4, 9.4, 9.6], 5);
  check('0.87 mm off a corner, 5 mm tolerance -> the corner itself',
        off.kind === 'vertex' && near(off.point[0], 10) && near(off.point[1], 10) && near(off.point[2], 10),
        off.kind + ' at ' + off.point.map(f3).join(', '));
  const onFace = M.snapPoint(topo, [0, 0, 10], 2);
  check('the middle of a 20 mm face snaps to nothing', onFace.kind === 'face',
        onFace.kind);
  const nearEdge = M.snapPoint(topo, [0, 9.2, 10], 2);
  check('1 mm off an edge, away from any corner -> a point on that edge',
        nearEdge.kind === 'edge' && near(nearEdge.point[1], 10) && near(nearEdge.point[2], 10),
        nearEdge.kind + ' at ' + nearEdge.point.map(f3).join(', '));
  const tight = M.snapPoint(topo, [9.4, 9.4, 9.6], 0.1);
  check('too far for the tolerance -> no snap, the click stands', tight.kind === 'face', tight.kind);

  console.log('\n=== A4. a mesher split an edge; the dimension did not change ===');
  const split = subdividedBox(40, 20, 10, 4);
  const a4 = chainHistogram(split);
  // 4 long edges x 4 pieces each = 16 places a click could land, and all 16
  // have to give the same answer. A tool that reports 40 from one end of an
  // edge and 30 from the middle of it is worse than no tool.
  check('all 16 pieces of the four 40 mm edges report 40.000',
        a4.hist.get('40.000') === 16, JSON.stringify(Object.fromEntries(a4.hist)));
  const topo4 = M.markFeatureEdges(M.buildTopology(split));
  const e40 = M.nearestFeatureEdge(topo4, [0, 5, 10]);
  const c40 = M.edgeChain(topo4, e40.edge);
  check('a click in the middle of one 10 mm piece still reports the whole 40',
        near(c40.length, 40) && c40.segments === 4,
        f3(c40.length) + ' mm in ' + c40.segments + ' segments');
  check('the other two dimensions are there too, unsplit',
        a4.hist.get('20.000') === 4 && a4.hist.get('10.000') === 4,
        JSON.stringify(Object.fromEntries(a4.hist)));

  console.log('\n=== A5. three more fixtures, each measured against its own bounding box ===');
  [['box_hull_80x40x20-2.stl', ['80.000', '40.000', '20.000']],
   ['lid_blank.stl', ['60.000', '40.000', '2.400']],
   ['out-box-square-half.stl', ['20.000', '10.000']]].forEach(([file, want]) => {
    const soup = readSTL(fx(file));
    const b = bbox(soup);
    const h = chainHistogram(soup).hist;
    check(file + ' bbox ' + b.size.map(f3).join(' x '), true);
    want.forEach(w => check('  reports a ' + w + ' mm edge', h.has(w),
                            'lengths seen: ' + [...h.keys()].join(', ')));
    // Nothing may exceed the piece: a chain that folded back on itself at a
    // T-junction is how a 20 mm edge once reported 40.
    const longest = Math.max(...[...h.keys()].map(Number));
    const span = Math.max(...b.size) + 1e-3;
    check('  no chain is longer than the piece (' + f3(longest) + ' <= ' + f3(span) + ')',
          longest <= span);
  });

  console.log('\n=== A6. the measure colour is nobody else\'s ===');
  /* A thin line drawn ON a piece has to beat the piece. This gate is source
     level on purpose: the colours live in six files as constants, and the way
     this breaks is somebody choosing a new accent without checking - which is
     exactly how this file's first two colours were picked and had to be
     changed (cyan onto a cyan piece, then rose onto what turned out to be a
     rose SELECTED piece). */
  const fs = require('fs');
  const src = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
  const mine = (src('app-measure.js').match(/MEASURE_COLOUR = (0x[0-9a-f]{6})/) || [])[1];
  check('app-measure.js names one colour constant', !!mine, mine);
  const TAKEN = [
    ['app-core.js', /PIECE_COLOR = (0x[0-9a-f]{6})/, 'an unselected piece'],
    ['app-core.js', /^const SELECT_COLOR = (0x[0-9a-f]{6})/m, 'a SELECTED piece'],
    ['app-mask.js', /SELECT_COLOR = (0x[0-9a-f]{6})/, 'Paint Selected'],
    ['app-defects.js', /OPEN_COLOR = (0x[0-9a-f]{6})/, 'open edges'],
    ['app-defects.js', /NM_COLOR\s*= (0x[0-9a-f]{6})/, 'non-manifold edges'],
    ['app-defects.js', /THIN_COLOR = (0x[0-9a-f]{6})/, 'thin walls'],
    ['app-poslock.js', /OUTLINE_COLOR = (0x[0-9a-f]{6})/, 'the position lock'],
  ];
  TAKEN.forEach(([file, re, who]) => {
    const m = (src(file).match(re) || [])[1];
    check('  not ' + who + ' (' + (m || '?') + ', ' + file + ')', !!m && m !== mine);
  });
  check('  not Paint Excluded (0xffdd00, app-mask.js)',
        /0xffdd00/.test(src('app-mask.js')) && mine !== '0xffdd00');

  console.log('\n=== A7. the printed form ===');
  check('20 mm prints as "20.000 mm"', M.formatMm(20) === '20.000 mm', M.formatMm(20));
  check('a metre-ish figure drops to 2 dp', M.formatMm(123.4567) === '123.46 mm', M.formatMm(123.4567));
  check('sub-millimetre keeps its digits', M.formatMm(0.4) === '0.400 mm', M.formatMm(0.4));
}

/* ------------------------------------------------------------------ part B */

// Where a world point lands on screen, through the app's own camera.
const screenOf = (page, p) => page.evaluate(pt => {
  const v = new THREE.Vector3(pt[0], pt[1], pt[2]).project(state.camera);
  const r = state.renderer.domElement.getBoundingClientRect();
  return { x: r.left + (v.x * 0.5 + 0.5) * r.width, y: r.top + (-v.y * 0.5 + 0.5) * r.height };
}, p);

// The piece's own world bounding box, measured by three.js.
const boxOf = (page, i) => page.evaluate(idx => {
  const p = state.placed[idx];
  p.mesh.updateMatrixWorld();
  const b = new THREE.Box3().setFromObject(p.mesh);
  return { min: b.min.toArray(), max: b.max.toArray() };
}, i);

const readout = page => page.evaluate(() => window.nsoMeasureReadout());

async function clickWorld(page, p) {
  const s = await screenOf(page, p);
  await page.mouse.move(s.x, s.y);
  await page.mouse.down();
  await page.mouse.up();
  // one frame, so the tick has re-measured and moved the chip
  await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
}

async function partB() {
  await withApp(async (page, logs) => {
    console.log('\n=== B1. the button is there and wired at load ===');
    const btn = await page.evaluate(() => {
      const b = document.getElementById('btn-measure');
      const s = document.getElementById('sel-measure-mode');
      return b ? { text: b.textContent.trim(), wired: b.dataset.nsoWired === '1',
                   modes: s ? [...s.options].map(o => o.value) : null } : null;
    });
    check('#btn-measure present', !!btn, btn ? 'label "' + btn.text + '"' : 'missing');
    check('listener attached at load', !!btn && btn.wired);
    check('both modes offered', !!btn && String(btn.modes) === 'span,edge', btn ? String(btn.modes) : '');
    check('the core is on the page as window.NSO_Measure',
          await page.evaluate(() => typeof window.NSO_Measure === 'object'));

    const id = await loadSTL(page, fx('box-20mm.stl'));
    await selectModel(page, id);
    // Shell v2: Measure lives in the column's Measure & check menu; open it.
    await openMenuFor(page, '#btn-measure');
    check('Measure is reachable in the open Measure & check menu',
          await page.isVisible('#btn-measure'));
    const box = await boxOf(page, 0);
    console.log('   box-20mm on the plate: ' + box.min.map(f3).join(', ') +
                '  ->  ' + box.max.map(f3).join(', '));

    console.log('\n=== B2. armed, a click measures instead of dragging the piece ===');
    await page.click('#btn-measure');
    check('measure mode is on', await page.evaluate(() => state.measureOn === true));
    check('and it says so the way the other mode buttons do',
          await page.getAttribute('#btn-measure', 'aria-pressed') === 'true');
    check('the button says so', (await page.textContent('#btn-measure')).indexOf('Measuring') === 0,
          await page.textContent('#btn-measure'));

    // Whatever #adjust-status says right now, measuring must not rewrite it -
    // that line is the paint's running count (app-mask.js's hudPaint), and two
    // tools writing one line is how a count turns into a lie.
    const hudBefore = await page.evaluate(() => document.getElementById('adjust-status').textContent);
    const before = await page.evaluate(() => ({ x: state.placed[0].x, z: state.placed[0].z }));
    // the top face's +X +Z corner, aimed at 0.6 mm inside it so the ray lands
    // on the face and the snap does the rest
    const cornerA = [box.max[0] - 0.6, box.max[1], box.max[2] - 0.6];
    const cornerB = [box.min[0] + 0.6, box.max[1], box.min[2] + 0.6];
    await clickWorld(page, cornerA);
    const after1 = await page.evaluate(() => ({ x: state.placed[0].x, z: state.placed[0].z,
                                                dragging: !!state.moveDragging }));
    check('the piece did not move under the click',
          near(before.x, after1.x) && near(before.z, after1.z) && !after1.dragging,
          'x ' + f3(after1.x) + ' z ' + f3(after1.z) + ' dragging ' + after1.dragging);
    check('one point down, no measurement yet', (await readout(page)) === null);

    await clickWorld(page, cornerB);
    const r2 = await readout(page);
    check('two clicks, one measurement', !!r2);
    const wantDiag = Math.hypot(box.max[0] - box.min[0], box.max[2] - box.min[2]);
    check('top-face diagonal = ' + f3(wantDiag) + ' mm', r2 && near(r2.mm, wantDiag, 5e-3),
          r2 ? f3(r2.mm) + ' mm' : 'nothing');
    check('both ends snapped to corners', r2 && String(r2.kinds) === 'vertex,vertex',
          r2 ? String(r2.kinds) : '');
    check('it is flat: dY = 0', r2 && near(r2.dy, 0), r2 ? f3(r2.dy) : '');
    check('dX and dZ are the box, to the micron',
          r2 && near(Math.abs(r2.dx), 20, 1e-4) && near(Math.abs(r2.dz), 20, 1e-4),
          r2 ? 'dX ' + f3(r2.dx) + ' dZ ' + f3(r2.dz) : '');

    console.log('\n=== B3. the number is on the screen, not just in a variable ===');
    const chip = await page.evaluate(() => {
      const el = document.getElementById('measure-label');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { text: el.textContent, hidden: el.hidden, w: r.width, h: r.height, x: r.left, y: r.top };
    });
    check('#measure-label is in the viewport and visible', !!chip && !chip.hidden && chip.w > 0 && chip.h > 0,
          chip ? JSON.stringify(chip) : 'missing');
    check('and it carries the measurement', !!chip && chip.text === r2.text,
          chip ? '"' + chip.text + '"' : '');
    const overCanvas = await page.evaluate(() => {
      const el = document.getElementById('measure-label').getBoundingClientRect();
      const c = state.renderer.domElement.getBoundingClientRect();
      return el.left > c.left && el.right < c.right && el.top > c.top && el.bottom < c.bottom;
    });
    check('the chip sits over the piece, inside the canvas', overCanvas);
    const statusLine = await page.evaluate(() => document.getElementById('status').textContent);
    check('the status line carries the axes too', /dX/.test(statusLine) && /dZ/.test(statusLine),
          statusLine);
    const hud = await page.evaluate(() => document.getElementById('adjust-status').textContent);
    check('the paint HUD line was left exactly as it was', hud === hudBefore,
          '"' + hud + '"');

    console.log('\n=== B4. move the piece; the measurement follows it and still reads the same ===');
    const moved = await page.evaluate(() => {
      const p = state.placed[0];
      applyPlacedXZ(p, p.x + 30, p.z - 12);
      return { x: p.x, z: p.z };
    });
    await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
    const r4 = await readout(page);
    check('same distance after a 30 / -12 mm move', r4 && near(r4.mm, r2.mm, 1e-4),
          r4 ? f3(r4.mm) + ' vs ' + f3(r2.mm) : '');
    check('both ends travelled with the piece',
          r4 && near(r4.a[0] - r2.a[0], 30, 1e-3) && near(r4.a[2] - r2.a[2], -12, 1e-3) &&
                near(r4.b[0] - r2.b[0], 30, 1e-3) && near(r4.b[2] - r2.b[2], -12, 1e-3),
          r4 ? 'end A moved ' + f3(r4.a[0] - r2.a[0]) + ', ' + f3(r4.a[2] - r2.a[2]) : '');
    await page.evaluate(m => { applyPlacedXZ(state.placed[0], m.x - 30, m.z + 12); }, moved);
    await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));

    console.log('\n=== B5. edge mode: one click, one edge, the whole edge ===');
    await page.selectOption('#sel-measure-mode', 'edge');
    const box5 = await boxOf(page, 0);
    // 1 mm in from the top face's +Z edge - a click NEAR an edge, the way a
    // person clicks one
    await clickWorld(page, [(box5.min[0] + box5.max[0]) / 2, box5.max[1], box5.max[2] - 1]);
    const r5 = await readout(page);
    check('an edge was measured', !!r5 && r5.type === 'edge', r5 ? r5.type : 'nothing');
    check('it is the 20 mm edge, in one segment',
          r5 && near(r5.mm, box5.max[0] - box5.min[0], 1e-4) && r5.segments === 1,
          r5 ? f3(r5.mm) + ' mm, ' + r5.segments + ' segment(s)' : '');
    check('it runs along X only',
          r5 && near(Math.abs(r5.dx), 20, 1e-4) && near(r5.dy, 0, 1e-4) && near(r5.dz, 0, 1e-4),
          r5 ? 'dX ' + f3(r5.dx) + ' dY ' + f3(r5.dy) + ' dZ ' + f3(r5.dz) : '');
    check('and its ends are the corners of that edge',
          r5 && near(r5.a[1], box5.max[1], 1e-4) && near(r5.b[1], box5.max[1], 1e-4) &&
                near(r5.a[2], box5.max[2], 1e-4) && near(r5.b[2], box5.max[2], 1e-4),
          r5 ? r5.a.map(f3).join(', ') + '  ->  ' + r5.b.map(f3).join(', ') : '');

    console.log('\n=== B6. a second piece: the 80 mm edge, and the gap between the two ===');
    const id2 = await loadSTL(page, fx('box_hull_80x40x20-2.stl'));
    await selectModel(page, id2);
    const box6 = await boxOf(page, 1);
    console.log('   80x40x20 hull on the plate: ' + box6.min.map(f3).join(', ') +
                '  ->  ' + box6.max.map(f3).join(', '));
    check('the app placed it 80 x 20 x 40 in display space (raw Z is up)',
          near(box6.max[0] - box6.min[0], 80) && near(box6.max[1] - box6.min[1], 20) &&
          near(box6.max[2] - box6.min[2], 40),
          [0, 1, 2].map(k => f3(box6.max[k] - box6.min[k])).join(' x '));
    await clickWorld(page, [(box6.min[0] + box6.max[0]) / 2, box6.max[1], box6.max[2] - 1]);
    const r6 = await readout(page);
    check('its long top edge reads 80.000 mm', r6 && near(r6.mm, 80, 1e-3),
          r6 ? f3(r6.mm) + ' mm in ' + r6.segments + ' segment(s)' : 'nothing');

    console.log('\n=== B7. across two pieces, and across them again after one moves ===');
    await page.selectOption('#sel-measure-mode', 'span');
    const a7 = [box5.max[0] - 0.6, box5.max[1], box5.max[2] - 0.6];
    const b7 = [box6.min[0] + 0.6, box6.max[1], box6.max[2] - 0.6];
    await clickWorld(page, a7);
    await clickWorld(page, b7);
    const r7 = await readout(page);
    const want7 = Math.hypot(box6.min[0] - box5.max[0], box6.max[1] - box5.max[1],
                             box6.max[2] - box5.max[2]);
    check('corner of piece 1 to corner of piece 2 = ' + f3(want7) + ' mm',
          r7 && near(r7.mm, want7, 5e-3), r7 ? f3(r7.mm) + ' mm' : 'nothing');
    check('both ends snapped', r7 && String(r7.kinds) === 'vertex,vertex', r7 ? String(r7.kinds) : '');

    await page.evaluate(() => { const p = state.placed[1]; applyPlacedXZ(p, p.x + 25, p.z); });
    await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
    const r7b = await readout(page);
    const want7b = Math.hypot(box6.min[0] + 25 - box5.max[0], box6.max[1] - box5.max[1],
                              box6.max[2] - box5.max[2]);
    check('piece 2 slides 25 mm and the reading follows to ' + f3(want7b) + ' mm',
          r7b && near(r7b.mm, want7b, 5e-3), r7b ? f3(r7b.mm) + ' mm' : 'nothing');

    console.log('\n=== B8. off again, and nothing left behind ===');
    await page.click('#btn-measure');
    const off = await page.evaluate(() => ({
      on: state.measureOn,
      readout: window.nsoMeasureReadout(),
      chip: (document.getElementById('measure-label') || {}).hidden,
      label: document.getElementById('btn-measure').textContent.trim(),
      status: document.getElementById('status').textContent
    }));
    check('mode off', off.on === false);
    check('measurement dropped', off.readout === null);
    check('chip hidden', off.chip === true);
    check('button back to "Measure"', off.label === 'Measure', off.label);
    const stray = await page.evaluate(() => {
      let n = 0;
      state.scene.traverse(o => { if (o.renderOrder === 30) n++; });
      return n;
    });
    check('no helper left in the scene', stray === 0, stray + ' at renderOrder 30');

    console.log('\n=== B9. arming Measure turns the other picking modes off ===');
    /* Paint (both lists), Carve, Soften and Cap all take a click that lands on
       a piece, and app-core asks them in a fixed order. Two armed at once does
       not crash - it makes the later one silently dead - so Measure turns the
       others off, THROUGH their buttons, so no button is left lit and inert. */
    for (const [id, name, flag] of [['btn-mask-paint', 'Paint Excluded', 'exclude'],
                                    ['btn-mask-select', 'Paint Selected', 'select'],
                                    ['btn-carve', 'Carve', null]]) {
      await page.click('#' + id);
      const armed = await page.evaluate(i => (i === 'btn-carve' ? !!state.carveArmed : state.maskPaint), id);
      check(name + ' arms', flag ? armed === flag : armed === true, String(armed));
      await page.click('#btn-measure');
      const after = await page.evaluate(i => ({
        other: (i === 'btn-carve' ? !!state.carveArmed : state.maskPaint),
        measure: state.measureOn,
        pressed: document.getElementById(i).getAttribute('aria-pressed')
      }), id);
      check('  Measure takes over and ' + name + ' stands down',
            !after.other && after.measure === true, JSON.stringify(after));
      check('  ...and its button is not left lit', after.pressed !== 'true', String(after.pressed));
      await page.click('#btn-measure');   // back to all-off for the next round
    }

    console.log('\n=== B10. the piece is unchanged - measuring is not a bake ===');
    const same = await page.evaluate(i => {
      const m = state.models.find(mm => mm.id === i);
      let v = 0;
      const s = m.rawTris;
      for (let t = 0; t < s.length / 9; t++) {
        const o = t * 9;
        v += (s[o] * (s[o + 4] * s[o + 8] - s[o + 5] * s[o + 7])
            - s[o + 1] * (s[o + 3] * s[o + 8] - s[o + 5] * s[o + 6])
            + s[o + 2] * (s[o + 3] * s[o + 7] - s[o + 4] * s[o + 6]));
      }
      return { tris: s.length / 9, volume: v / 6, painted: window.nsoMaskCount(m) };
    }, id);
    check('box-20mm is still 12 triangles of 8000 mm3',
          same.tris === 12 && near(same.volume, 8000, 1e-2),
          same.tris + ' tris, ' + f3(same.volume) + ' mm3');
    check('and the paint skip list was never touched', same.painted === 0);

    const errs = logs.filter(l => l.startsWith('[pageerror]'));
    check('no page errors', errs.length === 0, errs.join(' | '));
  });
}

(async () => {
  console.log('== Measure: the number on screen against the piece it is measuring ==');
  partA();
  await partB();
  console.log('\n' + (fails ? fails + ' FAILED' : 'all gates held'));
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error('MEASURE TEST FAIL', e); process.exit(1); });
