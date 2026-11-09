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
const RL = require('../app-ruler.js');
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

  console.log('\n=== A8. inches: the same length, printed the other way ===');
  check('the inch is exactly 25.4 mm', M.MM_PER_IN === 25.4 && RL.MM_PER_IN === 25.4);
  check('mm is untouched by the new formatter', M.formatLen(20, 'mm') === M.formatMm(20) && M.formatLen(123.4567) === '123.46 mm',
        M.formatLen(123.4567));
  check('25.4 mm is "1.0000 in"', M.formatLen(25.4, 'in') === '1.0000 in', M.formatLen(25.4, 'in'));
  check('20 mm is "0.7874 in"', M.formatLen(20, 'in') === '0.7874 in', M.formatLen(20, 'in'));
  check('4 decimals under 100 mm, 3 from there up (3.937 in)',
        M.formatLen(99.9, 'in') === '3.9331 in' && M.formatLen(100, 'in') === '3.937 in',
        M.formatLen(99.9, 'in') + ' / ' + M.formatLen(100, 'in'));
  check('a negative length keeps its sign', M.formatLen(-12.7, 'in') === '-0.5000 in', M.formatLen(-12.7, 'in'));
  check('per-axis deltas: bare numbers in either unit',
        M.formatNum(20, 'mm') === '20.000' && M.formatNum(20, 'in') === '0.7874' && M.formatNum(-25.4, 'in') === '-1.0000');

  console.log('\n=== A9. the ruler: what is drawn, and where ===');
  const labels = ts => ts.filter(t => t.label != null).map(t => t.label);
  const mm3 = RL.ticks('mm', 3, 0, 0, 1000);
  check('300 mm long: labelled every 10 mm, 0 to 300, nothing past it',
        labels(mm3).join(' ') === Array.from({ length: 31 }, (_, i) => i * 10).join(' ') && Math.max(...mm3.map(t => t.x)) === 900,
        labels(mm3).length + ' labels, last mark at x=' + Math.max(...mm3.map(t => t.x)));
  check('mm at 3 px/mm: 5 mm is the finest mark that fits (1 mm would be 3 px)', mm3.length === 61, mm3.length + ' marks');
  const mm6 = RL.ticks('mm', 6, 0, 0, 2000);
  check('zoomed in to 6 px/mm every millimetre gets a mark and numbers go every 5',
        mm6.length === 301 && labels(mm6)[1] === '5' && labels(mm6).length === 61, mm6.length + ' marks, ' + labels(mm6).length + ' labels');
  check('a mark sits exactly at x0 + mm * px/mm', mm3.every(t => Math.abs(t.x - t.v * 3) < 1e-9));
  const in3 = RL.ticks('in', 3, 0, 0, 1000);
  check('12 in is a real foot: 304.8 mm', RL.lengthMm('in') === 304.8 && RL.lengthMm('mm') === 300);
  check('inches: numbered 0..12, whole inches', labels(in3).join(' ') === '0 1 2 3 4 5 6 7 8 9 10 11 12', labels(in3).join(' '));
  check('inches at 3 px/mm: down to 1/16 (4.76 px), not 1/32 (2.38 px)',
        in3.length === 12 * 16 + 1 && in3.some(t => Math.abs(t.v - 1 / 16) < 1e-12) && !in3.some(t => Math.abs(t.v - 1 / 32) < 1e-12),
        in3.length + ' marks');
  check('the last inch mark is at 304.8 mm', Math.abs(Math.max(...in3.map(t => t.x)) - 304.8 * 3) < 1e-9);
  const rk = v => in3.find(t => Math.abs(t.v - v) < 1e-12).rank;
  check('a longer mark for a coarser step: 1/16 < 1/8 < 1/4 < 1/2 < 1 in, and 10 in the longest',
        rk(1 / 16) === 0 && rk(1 / 16) < rk(1 / 8) && rk(1 / 8) < rk(1 / 4) && rk(1 / 4) < rk(1 / 2) && rk(1 / 2) < rk(1) && rk(1) < rk(10) && rk(10) === 1,
        [1 / 16, 1 / 8, 1 / 4, 1 / 2, 1, 10].map(rk).map(x => x.toFixed(2)).join(' < '));
  const clip = RL.ticks('mm', 3, 0, 100, 200);
  check('only marks inside the asked range are made', clip.length > 0 && clip.every(t => t.x >= 100 && t.x <= 200), clip.length + ' marks');
  const neg = RL.ticks('mm', 3, -500, 0, 400);
  check('a ruler dragged half off the left edge still starts where it should',
        neg[0].x >= 0 && Math.abs(neg[0].v * 3 - 500 - neg[0].x) < 1e-9, 'first mark x=' + neg[0].x + ' (' + neg[0].v + ' mm)');
  check('seen from very far away there is still a mark', RL.ticks('mm', 0.05, 0, 0, 500).length > 0);
  check('and never a wall of them: bounded at any zoom', RL.ticks('in', 400, 0, 0, 1600).length < 400, RL.ticks('in', 400, 0, 0, 1600).length + ' marks');
  check('pixels per mm: 600 px at 300 mm, 45 deg = 2.4142', Math.abs(RL.pxPerMmAtDepth(300, 45, 600) - 2.41421356) < 1e-7,
        String(RL.pxPerMmAtDepth(300, 45, 600)));
  check('twice as far is half the scale', Math.abs(RL.pxPerMmAtDepth(600, 45, 600) * 2 - RL.pxPerMmAtDepth(300, 45, 600)) < 1e-12);
  check('a screen x reads back as mm along the ruler', Math.abs(RL.readingMm(2.5, 40, 140) - 40) < 1e-12);

  console.log('\n=== A10. an edge against the ruler: tilt and depth ===');
  const E = (ax, ay, bx, by, da, db) => RL.edgeAlignment({ x: ax, y: ay, depth: da == null ? 300 : da },
                                                         { x: bx, y: by, depth: db == null ? 300 : db }, 2);
  check('level: tilt 0, parallel', E(0, 0, 100, 0).tiltDeg === 0 && E(0, 0, 100, 0).parallel);
  check('climbing to the right is +45 (screen y is down)', Math.abs(E(0, 0, 10, -10).tiltDeg - 45) < 1e-9, String(E(0, 0, 10, -10).tiltDeg));
  check('falling to the right is -45', Math.abs(E(0, 0, 10, 10).tiltDeg + 45) < 1e-9);
  check('straight up is 90 whichever end is A', E(0, 0, 0, -10).tiltDeg === 90 && E(0, -10, 0, 0).tiltDeg === 90);
  check('naming the ends the other way round changes nothing',
        [[0, 0, 30, -7], [5, 5, 80, 60], [10, 0, 0, 3]].every(([a, b, c, d]) => Math.abs(E(a, b, c, d).tiltDeg - E(c, d, a, b).tiltDeg) < 1e-9));
  check('0.4 deg is along the ruler, 0.6 deg is not',
        E(0, 0, 1000, -Math.tan(0.4 * Math.PI / 180) * 1000).parallel && !E(0, 0, 1000, -Math.tan(0.6 * Math.PI / 180) * 1000).parallel);
  check('the span is along the ruler, not the edge length: a 3-4-5 edge spans 3',
        Math.abs(E(0, 0, 6, 8).spanMm - 3) < 1e-9, String(E(0, 0, 6, 8).spanMm));
  check('ends equally far from the camera: square to the view', E(0, 0, 10, 0, 300, 300).depthFrac === 0 && E(0, 0, 10, 0, 300, 300).square);
  check('ends 10 mm apart in depth at 300 mm: 3.3 %, not square',
        Math.abs(E(0, 0, 10, 0, 300, 310).depthFrac - 10 / 305) < 1e-12 && !E(0, 0, 10, 0, 300, 310).square);
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
    check('all four modes offered (two measure, two ruler-align)', !!btn && String(btn.modes) === 'span,edge,apoint,aedge', btn ? String(btn.modes) : '');
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


/* ------------------------------------------------------------------ part C
   The ruler and the inches toggle, in the real app. The scale is checked the
   way the rest of this file checks things: against the piece's own size, from
   a view where the answer is known (straight down, so a 20 mm edge on the top
   face is square to the camera and the ruler, being true at its depth, must
   read 20). */

const rulerRead = page => page.evaluate(() => window.nsoRulerReadout());
const frames = (page, n) => page.evaluate(k => new Promise(r => { let i = 0; (function f() { if (++i >= k) r(); else requestAnimationFrame(f); })(); }), n || 3);
const topDown = page => page.evaluate(() => {
  /* OrbitControls is damped: an earlier orbit leaves inertia that keeps turning
     the camera for seconds. One update() with damping off applies and zeroes it
     all, so "straight down" stays straight down. Damping stays off for the rest
     of this test, which has no use for the coast. */
  state.controls.enableDamping = false;
  state.controls.update();
  state.camera.position.set(0, 300, 0.001);
  state.controls.target.set(0, 0, 0);
  state.controls.update();
});

async function partC() {
  await withApp(async (page, logs) => {
    const id = await loadSTL(page, fx('box-20mm.stl'));
    await selectModel(page, id);
    await openMenuFor(page, '#btn-measure');
    const box = await boxOf(page, 0);
    const wantDiag = Math.hypot(box.max[0] - box.min[0], box.max[2] - box.min[2]);

    console.log('\n=== C1. the card: Inches, Ruler, Guides, Zero here ===');
    const card = await page.evaluate(() => ({
      inches: !!document.getElementById('chk-measure-inches') && document.getElementById('chk-measure-inches').checked,
      ruler: !!document.getElementById('chk-ruler') && document.getElementById('chk-ruler').checked,
      zero: document.getElementById('btn-ruler-zero') && document.getElementById('btn-ruler-zero').disabled,
      has: ['chk-measure-inches', 'chk-ruler', 'chk-ruler-guides', 'btn-ruler-zero'].every(i => !!document.getElementById(i)),
      unit: window.NSO_MeasureBridge && window.NSO_MeasureBridge.unit(),
      readout: window.nsoRulerReadout()
    }));
    check('all four controls are in the Measure card', card.has);
    check('it starts in millimetres, ruler off, Zero here disabled',
          card.unit === 'mm' && !card.inches && !card.ruler && card.zero === true && card.readout === null, JSON.stringify(card));

    console.log('\n=== C2. inches: the same measurement, printed in inches ===');
    await page.click('#btn-measure');
    await clickWorld(page, [box.max[0] - 0.6, box.max[1], box.max[2] - 0.6]);
    await clickWorld(page, [box.min[0] + 0.6, box.max[1], box.min[2] + 0.6]);
    let r = await readout(page);
    check('measured in mm first: ' + f3(wantDiag), r && r.text === f3(wantDiag) + ' mm' && r.unit === 'mm', r ? r.text : 'nothing');
    await page.click('#chk-measure-inches');
    await frames(page, 3);
    r = await readout(page);
    const wantIn = (wantDiag / 25.4).toFixed(4) + ' in';
    check('the box is ticked and the number is "' + wantIn + '"', r && r.text === wantIn && r.unit === 'in', r ? r.text : 'nothing');
    check('but the length itself is still millimetres: mm field and value/25.4',
          r && near(r.mm, wantDiag, 5e-3) && near(r.value, wantDiag / 25.4, 1e-6), r ? f3(r.mm) + ' / ' + r.value : '');
    check('the per-axis deltas stay in mm for whoever reads them', r && near(Math.abs(r.dx), 20, 1e-4), r ? f3(r.dx) : '');
    const chipIn = await page.evaluate(() => document.getElementById('measure-label').textContent);
    check('the chip on the piece says so', chipIn === wantIn, '"' + chipIn + '"');
    const stIn = await page.evaluate(() => document.getElementById('status').textContent);
    check('and the status line, with the axes in inches too',
          stIn.indexOf('Measure - ' + wantIn) === 0 && /dX -?0\.7874/.test(stIn), stIn);
    check('the choice is remembered in this browser',
          await page.evaluate(() => localStorage.getItem('nso.measure.unit')) === 'in');
    await page.click('#btn-measure');
    await page.click('#btn-measure');   // off, on: a fresh edge measurement
    await page.selectOption('#sel-measure-mode', 'edge');
    await clickWorld(page, [(box.min[0] + box.max[0]) / 2, box.max[1], box.max[2] - 1]);
    r = await readout(page);
    check('Edge mode in inches: 20 mm is "0.7874 in"', r && r.text === '0.7874 in' && r.segments === 1, r ? r.text : 'nothing');
    await page.click('#chk-measure-inches');
    await frames(page, 2);
    r = await readout(page);
    check('back to millimetres: "20.000 mm"', r && r.text === '20.000 mm' && r.unit === 'mm', r ? r.text : 'nothing');
    await page.click('#btn-measure');   // off

    console.log('\n=== C3. the ruler: on, 300 mm, and 12 in ===');
    await page.click('#chk-ruler');
    await frames(page, 3);
    let rr = await rulerRead(page);
    const vis = await page.evaluate(() => ['nso-ruler-canvas', 'nso-ruler-spine', 'nso-ruler-tools'].map(i => {
      const e = document.getElementById(i); return !!e && !e.hidden && e.getBoundingClientRect().width > 0;
    }));
    check('canvas, bar and buttons are up', vis.every(Boolean), String(vis));
    check('300 mm long in millimetres', rr && rr.lengthMm === 300 && rr.unit === 'mm', rr ? rr.lengthMm + ' ' + rr.unit : 'off');
    const spineW = await page.evaluate(() => document.getElementById('nso-ruler-spine').getBoundingClientRect().width);
    check('the bar is 300 mm at the scale it reports', rr && near(spineW, 300 * rr.pxPerMm, 1), f3(spineW) + ' px vs ' + f3(300 * rr.pxPerMm));
    await page.click('#chk-measure-inches');
    await frames(page, 3);
    rr = await rulerRead(page);
    check('ticking Inches makes it a 12 in ruler, 304.8 mm', rr && rr.lengthMm === 304.8 && rr.unit === 'in', rr ? rr.lengthMm + ' ' + rr.unit : '');
    check('its own unit button reads "in"', (await page.textContent('#nso-ruler-unit')) === 'in');
    await page.click('#nso-ruler-unit');
    await frames(page, 3);
    check('and clicking it switches back, and unticks the box',
          (await page.evaluate(() => !document.getElementById('chk-measure-inches').checked)) && (await rulerRead(page)).unit === 'mm');

    console.log('\n=== C4. drag it anywhere; it never turns ===');
    const host = await page.evaluate(() => { const r = document.querySelector('.viewport-section').getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
    const sp = async () => page.evaluate(() => { const r = document.getElementById('nso-ruler-spine').getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
    await page.evaluate(() => window.nsoRulerPlace(300, 300));
    await page.waitForTimeout(300);     // the scale re-samples at most every 100 ms; let it settle here first
    let s0 = await sp();
    const gx = s0.x + 200, gy = s0.y + s0.h / 2;
    await page.mouse.move(gx, gy); await page.mouse.down();
    await page.mouse.move(gx + 90, gy - 70, { steps: 6 });
    await frames(page, 4);
    const inHand = await sp();      // still held: the scale must not have been re-sampled yet
    await page.mouse.up();
    await frames(page, 2);
    let s1 = await sp();
    check('dragged 90 right and 70 up by its bar', near(s1.x - s0.x, 90, 1.5) && near(s1.y - s0.y, -70, 1.5), 'moved ' + f3(s1.x - s0.x) + ', ' + f3(s1.y - s0.y));
    check('no turn: same height and no transform',
          near(s1.h, s0.h, 0.01) && (await page.evaluate(() => getComputedStyle(document.getElementById('nso-ruler-spine')).transform)) === 'none',
          'h ' + f3(s1.h));
    check('the scale held still while the bar was in hand (no breathing as it slid over the piece)',
          near(inHand.w, s0.w, 0.5), 'width ' + f3(s0.w) + ' -> ' + f3(inHand.w) + ' held');
    // every corner of the viewport, and then well past it
    const corners = [['top-left', -2000, -2000], ['top-right', 4000, -2000], ['bottom-right', 4000, 4000], ['bottom-left', -2000, 4000]];
    for (const [name, dx, dy] of corners) {
      const a = await sp();
      await page.mouse.move(a.x + 120, a.y + a.h / 2); await page.mouse.down();
      await page.mouse.move(Math.max(1, Math.min(host.x + host.w - 1, a.x + 120 + dx)), Math.max(1, Math.min(host.y + host.h - 1, a.y + a.h / 2 + dy)), { steps: 8 });
      await page.mouse.up();
      await frames(page, 2);
      const b = await sp();
      const wantRight = dx > 0, wantBottom = dy > 0;
      const onScreen = b.y >= host.y - 0.5 && b.y + b.h <= host.y + host.h + 0.5 && b.x + b.w > host.x + 60 && b.x < host.x + host.w - 60;
      const atEdge = (wantBottom ? b.y + b.h + 28 >= host.y + host.h - 4 : b.y <= host.y + 18) && (wantRight ? b.x > host.x + host.w * 0.5 : b.x < host.x + host.w * 0.5);
      check('to the ' + name + ' of the viewport, and no further: still on screen and still grabbable', onScreen && atEdge,
            'bar ' + Math.round(b.x - host.x) + ',' + Math.round(b.y - host.y) + ' in ' + Math.round(host.w) + 'x' + Math.round(host.h));
    }

    console.log('\n=== C5. only the bar takes the mouse: the piece under the marks can still be orbited ===');
    await page.evaluate(() => window.nsoRulerPlace(300, 300));
    await frames(page, 2);
    s0 = await sp();
    const hit = await page.evaluate(p => {
      const spineEl = document.getElementById('nso-ruler-spine');
      const at = (x, y) => { const e = document.elementFromPoint(x, y); return e === spineEl ? 'spine' : e === state.renderer.domElement ? 'viewport' : (e ? e.id || e.className || e.tagName : 'nothing'); };
      return { bar: at(p.x + 400, p.y + p.h / 2), marks: at(p.x + 400, p.y + p.h + 8), labels: at(p.x + 400, p.y + p.h + 22) };
    }, s0);
    check('on the bar the pointer is the ruler\'s', hit.bar === 'spine', hit.bar);
    check('on the marks and the numbers it goes through to the viewport', hit.marks === 'viewport' && hit.labels === 'viewport', hit.marks + ' / ' + hit.labels);
    const cam0 = await page.evaluate(() => state.camera.position.toArray());
    await page.mouse.move(s0.x + 700, s0.y + s0.h + 8); await page.mouse.down();
    await page.mouse.move(s0.x + 780, s0.y + s0.h + 30, { steps: 6 }); await page.mouse.up();
    const cam1 = await page.evaluate(() => state.camera.position.toArray());
    check('a drag that starts on the marks orbits the camera', Math.hypot(cam1[0] - cam0[0], cam1[1] - cam0[1], cam1[2] - cam0[2]) > 1,
          'moved ' + f3(Math.hypot(cam1[0] - cam0[0], cam1[1] - cam0[1], cam1[2] - cam0[2])) + ' mm');
    check('and the ruler stayed where it was', near((await sp()).x, s0.x, 0.5) && near((await sp()).y, s0.y, 0.5));

    console.log('\n=== C6. Align point: the ruler is true at the point (looking straight down) ===');
    await topDown(page);
    await frames(page, 3);
    await page.selectOption('#sel-measure-mode', 'apoint');
    await page.click('#btn-measure');
    check('Align point armed Measure and the ruler is up', await page.evaluate(() => state.measureOn && document.getElementById('chk-ruler').checked));
    const topY = box.max[1];
    const pA = [box.min[0] + 0.6, topY, box.min[2] + 0.6], pB = [box.max[0] - 0.6, topY, box.min[2] + 0.6];
    const sA = await screenOf(page, pA);
    await page.mouse.move(sA.x, sA.y);
    await page.waitForTimeout(200);
    let hv = await rulerRead(page);
    check('hovering a corner previews it, with no reading (nothing is picked)', hv && hv.hover === 'point' && hv.pick === null, hv ? String(hv.hover) : 'off');
    await page.mouse.down(); await page.mouse.up();
    await frames(page, 3);
    rr = await rulerRead(page);
    check('picked: a point, and the scale is now true at the pick', rr && rr.pick && rr.pick.kind === 'point' && rr.depthSource === 'pick', rr ? rr.depthSource : 'off');
    check('Zero here is available', await page.evaluate(() => !document.getElementById('btn-ruler-zero').disabled));
    await page.click('#btn-ruler-zero');
    await frames(page, 3);
    rr = await rulerRead(page);
    check('Zero here puts the 0 mark on the corner', rr && rr.pick && Math.abs(rr.pick.aMm) < 0.01, rr && rr.pick ? f3(rr.pick.aMm) + ' mm' : 'nothing');
    const y0 = rr.y;
    const sB = await screenOf(page, pB);
    await page.mouse.move(sB.x, sB.y); await page.mouse.down(); await page.mouse.up();
    await frames(page, 3);
    rr = await rulerRead(page);
    check('the corner 20 mm along reads 20.000 on the ruler', rr && rr.pick && near(rr.pick.aMm, 20, 0.02), rr && rr.pick ? f3(rr.pick.aMm) + ' mm' : 'nothing');
    check('zeroing slid the ruler along but left it level where it was', rr && rr.y === y0, 'y ' + y0 + ' -> ' + rr.y);
    await page.click('#chk-measure-inches');
    await frames(page, 3);
    rr = await rulerRead(page);
    check('in inches it is 0.7874 in on a 12 in ruler', rr && rr.unit === 'in' && rr.lengthMm === 304.8 && near(rr.pick.aMm / 25.4, 0.7874, 2e-4),
          rr && rr.pick ? (rr.pick.aMm / 25.4).toFixed(4) + ' in' : 'nothing');
    await page.click('#chk-measure-inches');

    console.log('\n=== C7. Align edge: span, tilt and depth, and the lamps that say when to trust it ===');
    await page.selectOption('#sel-measure-mode', 'aedge');
    await page.click('#btn-measure');   // off
    await page.click('#btn-measure');   // on, in Align edge
    const eMid = [(box.min[0] + box.max[0]) / 2, topY, box.min[2] + 1];
    const sE = await screenOf(page, eMid);
    await page.mouse.move(sE.x, sE.y); await page.mouse.down(); await page.mouse.up();
    await frames(page, 3);
    rr = await rulerRead(page);
    const ep = rr && rr.pick;
    check('picked the whole 20 mm edge', ep && ep.kind === 'edge' && near(ep.trueMm, 20, 1e-3) && ep.segments === 1, ep ? f3(ep.trueMm) + ' mm' : 'nothing');
    check('square to the view: its span on the ruler is its length, 20.000', ep && near(ep.spanMm, 20, 0.02), ep ? f3(ep.spanMm) : '');
    check('it lies along the ruler: tilt 0 (within 0.05 deg), lamp on', ep && Math.abs(ep.tiltDeg) < 0.05 && ep.parallel === true, ep ? f3(ep.tiltDeg) + ' deg' : '');
    check('and equally far from the camera at both ends: lamp on', ep && ep.depthFrac < 1e-4 && ep.square === true, ep ? String(ep.depthFrac) : '');
    // slide the piece 30 mm along X: both marks move 30 mm along the ruler
    const a0 = ep.aMm, b0 = ep.bMm;
    await page.evaluate(() => { const p = state.placed[0]; applyPlacedXZ(p, p.x + 30, p.z); });
    await frames(page, 3);
    rr = await rulerRead(page);
    check('the piece moves 30 mm and both ends move 30 mm along the ruler',
          rr && rr.pick && near(rr.pick.aMm - a0, 30, 0.05) && near(rr.pick.bMm - b0, 30, 0.05) && near(rr.pick.spanMm, 20, 0.02),
          rr && rr.pick ? 'a ' + f3(rr.pick.aMm - a0) + ', b ' + f3(rr.pick.bMm - b0) : 'nothing');
    // Orbit to the ordinary 3/4 view: the same edge is no longer square to the view
    await page.evaluate(() => { state.camera.position.set(160, 180, 200); state.controls.target.set(0, 0, 0); state.controls.update(); });
    await frames(page, 3);
    rr = await rulerRead(page);
    const tp = rr && rr.pick;
    check('from the 3/4 view the lamps go out: it is tilted and one end is nearer',
          tp && tp.parallel === false && tp.square === false && Math.abs(tp.tiltDeg) > 1 && tp.depthFrac > 0.005,
          tp ? 'tilt ' + f3(tp.tiltDeg) + ' deg, depth ' + (tp.depthFrac * 100).toFixed(2) + ' %' : 'nothing');
    check('and the span on the ruler is no longer the length (it would be wrong to read it as 20)', tp && Math.abs(tp.spanMm - 20) > 0.5, tp ? f3(tp.spanMm) : '');
    await topDown(page);
    await frames(page, 3);

    console.log('\n=== C8. picks end when they should ===');
    await page.keyboard.press('Escape');
    await frames(page, 2);
    check('Esc clears the pick', (await rulerRead(page)).pick === null);
    const sE2 = await screenOf(page, [box.min[0] + 30 + 10, topY, box.min[2] + 1]);
    await page.mouse.move(sE2.x, sE2.y); await page.mouse.down(); await page.mouse.up();
    await frames(page, 3);
    check('picked again', (await rulerRead(page)).pick !== null);
    await page.evaluate(() => { const p = state.placed[0]; p.mesh.geometry = p.mesh.geometry.clone(); });
    await frames(page, 4);
    check('re-baking the piece (new geometry) drops the pick instead of showing a stale one', (await rulerRead(page)).pick === null);
    check('and says why', /Ruler pick cleared/.test(await page.evaluate(() => document.getElementById('status').textContent)));
    check('Zero here goes grey again', await page.evaluate(() => document.getElementById('btn-ruler-zero').disabled));
    await page.click('#btn-measure');   // measure off
    rr = await rulerRead(page);
    check('leaving Measure leaves the ruler up (it is not a measure mode)', rr && rr.on === true);

    console.log('\n=== C9. Guides, Flip, and off ===');
    await page.click('#chk-ruler-guides');
    await frames(page, 2);
    check('Guides on', (await rulerRead(page)).guides === true);
    await page.click('#nso-ruler-flip');
    await frames(page, 2);
    check('Flip turns the marks to the other side', (await rulerRead(page)).flip === true);
    await page.click('#nso-ruler-close');
    await frames(page, 2);
    const down = await page.evaluate(() => ({
      box: document.getElementById('chk-ruler').checked,
      cv: document.getElementById('nso-ruler-canvas').hidden,
      spine: document.getElementById('nso-ruler-spine').hidden,
      readout: window.nsoRulerReadout()
    }));
    check('the x button hides it and unticks Ruler', !down.box && down.cv && down.spine && down.readout === null, JSON.stringify(down));

    console.log('\n=== C10. the ruler changes nothing ===');
    const same = await page.evaluate(i => {
      const m = state.models.find(mm => mm.id === i);
      let v = 0;
      const t = m.rawTris;
      for (let k = 0; k < t.length / 9; k++) {
        const o = k * 9;
        v += (t[o] * (t[o + 4] * t[o + 8] - t[o + 5] * t[o + 7]) - t[o + 1] * (t[o + 3] * t[o + 8] - t[o + 5] * t[o + 6]) + t[o + 2] * (t[o + 3] * t[o + 7] - t[o + 4] * t[o + 6]));
      }
      let strays = 0;
      state.scene.traverse(o => { if (o.renderOrder === 30) strays++; });
      return { tris: t.length / 9, volume: v / 6, painted: window.nsoMaskCount(m), strays };
    }, id);
    check('still 12 triangles of 8000 mm3, nothing painted', same.tris === 12 && near(same.volume, 8000, 1e-2) && same.painted === 0,
          same.tris + ' tris, ' + f3(same.volume) + ' mm3');
    check('and it put nothing in the scene (it is drawn on the screen)', same.strays === 0, same.strays + ' at renderOrder 30');
    const errs = logs.filter(l => l.startsWith('[pageerror]'));
    check('no page errors', errs.length === 0, errs.join(' | '));
  });
}

/* ------------------------------------------------------------------ part D
   Measure beside a live tool. A ghost being manipulated, or a card doing live
   work, must survive Measure being opened, armed and used - closing a panel
   ends its session, and that is what opening Measure used to do. */

const panelRect = (page, id) => page.evaluate(i => {
  const b = document.querySelector('#' + i + ' > .vp-menu-body');
  const r = b && b.getBoundingClientRect();
  return r && r.width > 0 ? { l: r.left, r: r.right, t: r.top, b: r.bottom } : null;
}, id);
const overlap = (a, b) => !!a && !!b && a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b;
const strays30 = page => page.evaluate(() => { let n = 0; state.scene.traverse(o => { if (o.renderOrder === 30) n++; }); return n; });

async function partD() {
  await withApp(async (page, logs) => {
    const id = await loadSTL(page, fx('box_hull_80x40x20-2.stl'));
    await selectModel(page, id);
    await page.evaluate(() => { state.camera.position.set(60, 70, 90); state.controls.target.set(0, 5, 0); state.controls.update(); });

    console.log('\n=== D1. a Crop ghost stays up while Measure opens, arms and measures ===');
    await page.click('#menu-crop > summary');
    await page.evaluate(() => { selectPlaced(0); });
    await page.click('#btn-crop-shape-box');
    await page.waitForFunction(() => { const S = NSO_CropCard.state(); return S.shape && !S.timer && S.plan; }, null, { timeout: 20000 });
    const box0 = await page.evaluate(() => JSON.parse(JSON.stringify(NSO_CropCard.state().box)));
    check('a Crop box is up', !!box0 && (await page.evaluate(() => !!NSO_CropCard.state().group)));
    await page.click('#menu-measure > summary');
    await page.waitForTimeout(200);
    const open1 = await page.evaluate(() => ({ crop: document.getElementById('menu-crop').open, measure: document.getElementById('menu-measure').open,
                                               shape: NSO_CropCard.shape(), group: !!NSO_CropCard.state().group }));
    check('opening the Measure card shuts nothing: Crop is still open', open1.crop && open1.measure, JSON.stringify(open1));
    check('and the ghost is still there', !!open1.shape && open1.group);
    const rc = await panelRect(page, 'menu-crop'), rm = await panelRect(page, 'menu-measure');
    check('the two panels sit side by side, not on top of each other', !!rc && !!rm && !overlap(rc, rm) && rm.l >= rc.r,
          'crop ' + JSON.stringify(rc && [Math.round(rc.l), Math.round(rc.r)]) + ' measure ' + JSON.stringify(rm && [Math.round(rm.l), Math.round(rm.r)]));
    check('Measure is reachable: its button is on screen and clickable', await page.isVisible('#btn-measure'));
    await page.click('#btn-measure');
    const armed = await page.evaluate(() => ({ on: state.measureOn, crop: document.getElementById('menu-crop').open, shape: NSO_CropCard.shape() }));
    check('arming Measure leaves the Crop session alone', armed.on && armed.crop && !!armed.shape, JSON.stringify(armed));

    // a press on a Crop handle is the ghost's, not a measurement
    const hx = await page.evaluate(() => NSO_CropCard.handleScreen('x+'));
    await page.mouse.move(hx.x, hx.y); await page.mouse.down();
    for (let i = 1; i <= 6; i++) await page.mouse.move(hx.x + 7 * i, hx.y + 1 * i);
    await page.mouse.up();
    await frames(page, 3);
    const box1 = await page.evaluate(() => NSO_CropCard.state().box);
    check('a handle still drags with Measure armed: the box grew on x+', box1.h[0] > box0.h[0] + 0.3, box0.h[0].toFixed(2) + ' -> ' + box1.h[0].toFixed(2));
    check('...and that press measured nothing (no first point, no marks)',
          (await readout(page)) === null && (await strays30(page)) === 0 && !/first point/.test(await page.evaluate(() => document.getElementById('status').textContent)));

    // a click on the piece clear of the ghost is a measurement
    const hb = await boxOf(page, 0);
    // the +X end: in this view it is on the right of the screen, clear of the two panels on the left
    const pA = [hb.max[0] - 0.6, hb.max[1], hb.max[2] - 0.6], pB = [hb.max[0] - 0.6, hb.max[1], hb.min[2] + 0.6];
    const under = await Promise.all([pA, pB].map(async p => { const s = await screenOf(page, p); return page.evaluate(q => document.elementFromPoint(q.x, q.y) === state.renderer.domElement, s); }));
    check('(the two points are on the canvas, not behind a panel)', under.every(Boolean), String(under));
    await clickWorld(page, pA);
    await clickWorld(page, pB);
    const rd = await readout(page);
    check('two clicks on the piece, clear of the ghost, measure it (40 mm across the end)', rd && near(rd.mm, hb.max[2] - hb.min[2], 5e-3), rd ? f3(rd.mm) : 'nothing');
    const box2 = await page.evaluate(() => NSO_CropCard.state().box);
    check('and the ghost did not move for it', [0, 1, 2].every(k => near(box2.c[k], box1.c[k], 1e-6) && near(box2.h[k], box1.h[k], 1e-6)));
    check('Crop is still open with its shape', await page.evaluate(() => document.getElementById('menu-crop').open && !!NSO_CropCard.shape()));

    console.log('\n=== D2. the ruler beside a ghost ===');
    await page.click('#chk-ruler');
    await frames(page, 3);
    const sp0 = await page.evaluate(() => { const r = document.getElementById('nso-ruler-spine').getBoundingClientRect(); return { x: r.left, y: r.top, h: r.height }; });
    await page.mouse.move(sp0.x + 250, sp0.y + sp0.h / 2); await page.mouse.down();
    await page.mouse.move(sp0.x + 330, sp0.y + sp0.h / 2 - 60, { steps: 6 }); await page.mouse.up();
    await frames(page, 3);
    const sp1 = await page.evaluate(() => { const r = document.getElementById('nso-ruler-spine').getBoundingClientRect(); return { x: r.left, y: r.top }; });
    const box3 = await page.evaluate(() => NSO_CropCard.state().box);
    check('the ruler drags with a ghost up', near(sp1.x - sp0.x, 80, 1.5) && near(sp1.y - sp0.y, -60, 1.5), (sp1.x - sp0.x).toFixed(1) + ', ' + (sp1.y - sp0.y).toFixed(1));
    check('...and the ghost is where it was', [0, 1, 2].every(k => near(box3.c[k], box2.c[k], 1e-6)));
    await page.click('#chk-ruler');
    await page.click('#btn-measure');   // off

    console.log('\n=== D3. another tool\'s claim on a press wins over Measure ===');
    // A handle press is preventDefault'd, or reported by a predicate. Either way it is not a measurement.
    await page.click('#btn-crop-cancel');
    await page.click('#btn-measure');
    await page.evaluate(() => window.addEventListener('pointerdown', window.__claim = e => { e.preventDefault(); }, true));
    await clickWorld(page, pA);
    check('a press something else prevented is not a measurement', (await strays30(page)) === 0 && (await readout(page)) === null);
    await page.evaluate(() => { window.removeEventListener('pointerdown', window.__claim, true); window.nsoWheelTakesPointer = () => true; });
    await clickWorld(page, pA);
    check('nor is one the Wheel says is its own', (await strays30(page)) === 0 && (await readout(page)) === null);
    await page.evaluate(() => { delete window.nsoWheelTakesPointer; window.nsoFoamTakesPointer = () => true; });
    await clickWorld(page, pA);
    check('nor one Foam says is its own', (await strays30(page)) === 0);
    await page.evaluate(() => { delete window.nsoFoamTakesPointer; });
    await clickWorld(page, pA);
    check('and with nobody claiming it, it is (control)', (await strays30(page)) > 0);
    await page.click('#btn-measure'); await page.click('#btn-measure');   // off, on: clear the lone first point
    await page.click('#btn-measure');

    console.log('\n=== D4. a live card with work in progress: Cut ===');
    await page.evaluate(() => { document.querySelectorAll('.vp-menu[open]').forEach(d => { if (d.id !== 'menu-measure') d.open = false; }); });
    await page.click('#menu-cut > summary');
    await page.waitForTimeout(300);
    const cut0 = await page.evaluate(() => ({ open: state.cutterOpen, measure: document.getElementById('menu-measure').open }));
    check('the Cut card opens with the Measure card already open (it no longer shuts it)', cut0.open && cut0.measure, JSON.stringify(cut0));
    const rc2 = await panelRect(page, 'menu-cut'), rm2 = await panelRect(page, 'menu-measure');
    check('side by side again, Measure having moved over to make room', !overlap(rc2, rm2), JSON.stringify([rc2 && Math.round(rc2.r), rm2 && Math.round(rm2.l)]));
    await page.click('#btn-measure');
    const cut1 = await page.evaluate(() => ({ cutter: !!state.cutterOpen, cutOpen: document.getElementById('menu-cut').open, measure: !!state.measureOn }));
    check('arming Measure over a live cutter leaves the cutter open', cut1.cutter && cut1.cutOpen && cut1.measure, JSON.stringify(cut1));
    await page.evaluate(() => { document.getElementById('menu-cut').open = false; });
    await page.waitForTimeout(200);
    const back = await panelRect(page, 'menu-measure');
    check('when the other card goes, Measure goes back to the shared spot', !!back && near(back.l, rc2.l, 2), back ? Math.round(back.l) + ' vs ' + Math.round(rc2.l) : 'gone');
    await page.click('#btn-measure');

    console.log('\n=== D5. what still shuts Measure ===');
    await page.evaluate(() => { document.getElementById('menu-crop').open = true; });
    await page.waitForTimeout(100);
    const two = await page.evaluate(() => [...document.querySelectorAll('.vp-menu[open]')].map(d => d.id).sort().join(','));
    check('Measure and one other card can be open together', two === 'menu-crop,menu-measure', two);
    await page.evaluate(() => { document.getElementById('menu-scale').open = true; });
    await page.waitForTimeout(100);
    const three = await page.evaluate(() => [...document.querySelectorAll('.vp-menu[open]')].map(d => d.id).sort().join(','));
    check('but two other cards still shut each other (the rule is otherwise as it was)', three === 'menu-measure,menu-scale', three);
    const errs = logs.filter(l => l.startsWith('[pageerror]'));
    check('no page errors', errs.length === 0, errs.join(' | '));
  });
}

(async () => {
  console.log('== Measure: the number on screen against the piece it is measuring ==');
  partA();
  await partB();
  await partC();
  await partD();
  console.log('\n' + (fails ? fails + ' FAILED' : 'all gates held'));
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error('MEASURE TEST FAIL', e); process.exit(1); });
