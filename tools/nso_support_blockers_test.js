#!/usr/bin/env node
/* Supports Blockers (nso_support_blockers.js, and the Supports card's use of them). Node only - no browser.
     node tools/nso_support_blockers_test.js        exit 0 = every gate held
     npm run support:blockers

   The card is its own file, run for real in a vm with three.js and the planner's engine (tools/nso_support_plate_lib.js, as
   support:plate does); the boxes are put on state.supportBlockers the way app-support-blockers.js keeps them. The pointer
   side - the box in the view, its handles, the button, the right-click item - is support:blockers-drive's.

   Gates:
     A  the box: bounds, a point on a face is in, overlapping (and touching) boxes are one area, the obstacle soup is a closed
        outward-wound box
     B  a footprint cut by a box: untouched when no box reaches its surface (the same object), the held part gone where one
        does (area to a cell), nothing left when a box holds it all, the surface read at its own height (a box above or below
        the surface holds none of it)
     C  a plate with no blocker builds the bytes it built before: a box far from the piece, and an empty list, change nothing
     D  a box across the middle of a bridge's underside: its spots are not planned or counted ("N spots blocked"), the area's
        outline is cut, the sheet stands either side and not between, and no vertex of any support is inside the box
     E  two boxes that overlap block the union of what each holds, once
     F  a box that holds every spot: the card says so, Generate is off, a build adds nothing
     G  Generate for plate: the plate's line counts what the boxes hold, per piece
     H  Slice and Preview: the Slice card's slice, then G-scope - run, refused, cancelled, busy; the card is locked meanwhile */
'use strict';
const lib = require('./nso_support_plate_lib.js');
const BL = require('../nso_support_blockers.js');

let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail !== undefined && (!cond || process.env.VERBOSE) ? ' - ' + detail : ''));
  if (!cond) fails++;
};
const section = t => console.log('\n== ' + t);
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const loopArea = L => { let a = 0; for (let q = 0, w = L.length - 1; q < L.length; w = q++) a += L[w][0] * L[q][1] - L[q][0] * L[w][1]; return Math.abs(a) / 2; };
const fpArea = fp => fp ? fp.loops.map(loopArea).reduce((s, v) => s + v, 0) : 0;      // outer loops only here: no holes in these footprints

function closedAndWound(tris) {
  const edge = new Map(), key = (a, b) => a.join(',') + '>' + b.join(',');
  for (let t = 0; t < tris.length; t += 9) {
    const v = [0, 1, 2].map(k => [tris[t + 3 * k], tris[t + 3 * k + 1], tris[t + 3 * k + 2]]);
    for (let k = 0; k < 3; k++) { const a = v[k], b = v[(k + 1) % 3]; edge.set(key(a, b), (edge.get(key(a, b)) || 0) + 1); }
  }
  for (const [e, n] of edge) { const [a, b] = e.split('>'); if (n !== 1 || edge.get(b + '>' + a) !== 1) return false; }
  return true;
}
function signedVolume(tris) {
  let v = 0;
  for (let t = 0; t < tris.length; t += 9) {
    const a = tris.slice(t, t + 3), b = tris.slice(t + 3, t + 6), c = tris.slice(t + 6, t + 9);
    v += (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6;
  }
  return v;
}

/* a bridge: a 60 x 30 slab on two 8 mm legs, its underside at z = 18, flat. Its spots stand on a 3 mm grid. */
const BENCH = () => lib.shape('bench', lib.benchSoup(60, 30, 20, 8));
const withBoxes = (app, specs) => { app.state.supportBlockers = specs.map((s, i) => BL.fromBounds(s[0], s[1], i + 1)); };

async function openBench(extra) {
  const app = lib.makeApp(extra);
  const ids = app.load([BENCH()]);
  app.openCard(); app.frame(); await app.sleep(30);
  app.card.pick(ids[0]);
  return { app, id: ids[0] };
}
async function build(app) {
  app.click('btn-sup-all');
  await app.until(() => !app.card.busy(), 120000);
}
/* the vertices of every support, in the card's frame */
function verts(app) {
  const out = [];
  for (const m of app.allSupports()) { const s = app.soupOf(m.id); for (let i = 0; i < s.length; i += 3) out.push([s[i], s[i + 1], s[i + 2]]); }
  return out;
}

(async () => {
  section('A  the box');
  {
    const b = BL.fromBounds([0, 0, 0], [10, 20, 30], 7);
    check('fromBounds / bounds round-trip', JSON.stringify(BL.bounds(b)) === JSON.stringify({ lo: [0, 0, 0], hi: [10, 20, 30] }) && b.id === 7);
    check('a point inside is blocked, a point on a face is blocked, a point outside is not',
      BL.blocked([b], 5, 10, 15) && BL.blocked([b], 10, 20, 30) && BL.blocked([b], 0, 0, 0) && !BL.blocked([b], 10.01, 10, 15) && !BL.blocked([b], 5, 10, -0.01));
    check('no box blocks nothing', !BL.blocked([], 0, 0, 0));
    const c = BL.fromBounds([8, 0, 0], [20, 20, 30], 8), d = BL.fromBounds([10, 0, 0], [12, 5, 5], 9), e = BL.fromBounds([40, 40, 40], [50, 50, 50], 10);
    check('boxes that overlap, or touch on a face, are one area; a far box is another',
      JSON.stringify(BL.areas([b, c, e]).map(g => g.map(x => x.id))) === '[[7,8],[10]]' && JSON.stringify(BL.areas([b, d, e]).map(g => g.map(x => x.id))) === '[[7,9],[10]]',
      JSON.stringify(BL.areas([b, c, e]).map(g => g.map(x => x.id))));
    check('boxes chained through a third are one area', BL.areas([b, BL.fromBounds([10, 0, 0], [30, 20, 30], 11), BL.fromBounds([30, 0, 0], [40, 20, 30], 12)]).length === 1);
    const so = BL.soupOf(b);
    check('the obstacle soup is 12 triangles, closed, each edge once each way', so.length === 108 && closedAndWound(so));
    check('...wound outward (positive volume = the box\'s own)', near(signedVolume(so), 10 * 20 * 30, 1e-3), signedVolume(so));
    const kept = BL.filterBeacons([{ x: 5, y: 5, z: 5 }, { x: 50, y: 5, z: 5 }, { x: 10, y: 20, z: 30 }], [b]);
    check('filterBeacons splits the held from the kept (a point on a face is held)', kept.kept.length === 1 && kept.held.length === 2 && kept.kept[0].x === 50);
  }

  section('B  a footprint cut by a box');
  {
    const loops = [[[0, 0, 10], [20, 0, 10], [20, 20, 10], [0, 20, 10], [0, 0, 10]]];
    const spots = [];
    for (let x = 1.5; x < 20; x += 3) for (let y = 1.5; y < 20; y += 3) spots.push({ x, y, z: 10, normal: [0, 0, -1] });
    const fp = { loops };
    check('a box far from the footprint leaves it the same object', BL.clipFootprint(fp, spots, [BL.fromBounds([50, 5, 8], [60, 30, 12], 1)], 3) === fp);
    check('a box over it, above its surface, holds none of it: the same object', BL.clipFootprint(fp, spots, [BL.fromBounds([5, 5, 12], [12, 30, 15], 1)], 3) === fp);
    check('...and one below it', BL.clipFootprint(fp, spots, [BL.fromBounds([5, 5, 2], [12, 30, 8], 1)], 3) === fp);
    const cut = BL.clipFootprint(fp, spots, [BL.fromBounds([5, 5, 8], [12, 30, 12], 1)], 3);
    check('a box across a corner takes its part out: 400 less 7 x 15 mm2 to a cell', cut && cut.clipped && near(fpArea(cut), 400 - 7 * 15, 400 * 0.03), fpArea(cut));
    check('...its loops keep the surface\'s height', cut.loops.every(L => L.every(q => near(q[2], 10, 1e-6))));
    check('...no point of what is left lies inside the box (a cell\'s margin)', cut.loops.every(L => L.every(q => !(q[0] > 5.3 && q[0] < 11.7 && q[1] > 5.3))));
    check('a box that holds all of it leaves nothing', BL.clipFootprint(fp, spots, [BL.fromBounds([-5, -5, 8], [60, 60, 12], 1)], 3) === null);
    const sloped = spots.map(s => ({ x: s.x, y: s.y, z: 10 + s.x * 0.5, normal: [-0.447, 0, -0.894] }));          // a ramp: z = 10 + x / 2
    const slopedFp = { loops: loops.map(L => L.map(q => [q[0], q[1], 10 + q[0] * 0.5])) };
    const ramp = BL.clipFootprint(slopedFp, sloped, [BL.fromBounds([0, 0, 14], [20, 20, 30], 1)], 3);
    check('a box over the high end of a ramp holds only the part of the surface that is in it (z >= 14: x >= 8, 240 of 400 mm2 left)', ramp && near(fpArea(ramp), 160, 400 * 0.04), fpArea(ramp));
  }

  section('C  no blocker: the bytes it built before');
  {
    const base = await openBench();
    await build(base.app);
    const h0 = base.app.hashSupports();
    check('the bridge builds a support', base.app.allSupports().length === 1 && /^Built/.test(base.app.head()), base.app.head());
    const far = await openBench();
    withBoxes(far.app, [[[300, 300, 0], [320, 320, 20]]]);
    far.app.card.pick(far.id);
    check('a box a long way off blocks no spot and the readout says nothing of it', !/blocked/.test(far.app.head()), far.app.head());
    await build(far.app);
    const h1 = far.app.hashSupports();
    check('...and builds the very same bytes', h1.sha === h0.sha && h1.triangles === h0.triangles, h0.sha.slice(0, 12) + ' ' + h1.sha.slice(0, 12));
    const empty = await openBench();
    empty.app.state.supportBlockers = [];
    empty.app.card.pick(empty.id);
    await build(empty.app);
    check('an empty list builds them too', empty.app.hashSupports().sha === h0.sha);
  }

  section('D  a box across the middle of the bridge');
  {
    const { app, id } = await openBench();
    const v0 = app.card.view();
    const z = v0.beacons[0].p[2];
    check('the underside is one flat area of spots', v0.areas.length === 1 && v0.beacons.length > 100, v0.beacons.length + ' spots');
    withBoxes(app, [[[-5, -30, z - 3], [5, 30, z + 3]]]);
    app.frame(); await app.sleep(20);
    app.card.pick(id);
    const v1 = app.card.view();
    const held = v0.beacons.length - v1.beacons.length;
    const expectHeld = v0.beacons.filter(b => b.p[0] >= -5 && b.p[0] <= 5).length;
    check('the spots in the box are not on the card', held > 0 && held === expectHeld && v1.beacons.every(b => b.p[0] < -5 || b.p[0] > 5), held + ' of ' + v0.beacons.length);
    check('the readout counts them as blocked', app.head() === '1 hanging area at 35° on bench · ' + held + ' spots blocked', app.head());
    check('the area is still one, and its outline is cut (it was a rectangle: now it has the box\'s notch)', v1.areas.length === 1 && v1.areas[0].outlineEdges > v0.areas[0].outlineEdges, v0.areas[0].outlineEdges + ' -> ' + v1.areas[0].outlineEdges);
    await build(app);
    check('it builds', /^Built: 1 support/.test(app.head()) && app.allSupports().length === 1, app.head());
    const vs = verts(app), bo = BL.bounds(app.state.supportBlockers[0]);
    const inside = vs.filter(p => p[0] > bo.lo[0] + 1e-3 && p[0] < bo.hi[0] - 1e-3 && p[1] > bo.lo[1] + 1e-3 && p[1] < bo.hi[1] - 1e-3 && p[2] > bo.lo[2] + 1e-3 && p[2] < bo.hi[2] - 1e-3);
    check('no vertex of any support is inside the box', inside.length === 0, inside.length + ' inside');
    const sheet = vs.filter(p => p[2] > z - 1.8 && p[2] < z + 0.5);          // the sheet and its caps, under the part
    const each = (a, b) => sheet.filter(p => p[0] >= a && p[0] <= b).length;
    check('the sheet stands to the left of the box and to the right of it', each(-20, -6) > 500 && each(6, 20) > 500, each(-20, -6) + ' / ' + each(6, 20));
    check('...and not between (nearer the box than a bead\'s width)', each(-4.2, 4.2) === 0, each(-4.2, 4.2) + ' vertices');
    const lone = await openBench();
    await build(lone.app);
    const loneSheet = verts(lone.app).filter(p => p[2] > z - 1.8 && p[2] < z + 0.5).filter(p => p[0] >= -4.2 && p[0] <= 4.2).length;
    check('(without the box the same band is full of sheet - the gate is not vacuous)', loneSheet > 500, loneSheet + ' vertices');
    check('Undo of the build and the supports taken off leaves the box where it was', (() => { app.undo(); return app.state.supportBlockers.length === 1 && app.allSupports().length === 0; })());
  }

  section('E  two boxes that overlap');
  {
    const { app, id } = await openBench();
    const v0 = app.card.view(), z = v0.beacons[0].p[2];
    withBoxes(app, [[[-5, -30, z - 3], [5, 30, z + 3]], [[2, -30, z - 3], [12, 30, z + 3]]]);
    app.frame(); await app.sleep(20);
    app.card.pick(id);
    const v1 = app.card.view();
    const union = v0.beacons.filter(b => b.p[0] >= -5 && b.p[0] <= 12).length;
    check('the spots in either box are held, once: the union (-5 .. 12)', v0.beacons.length - v1.beacons.length === union && v1.beacons.every(b => b.p[0] < -5 || b.p[0] > 12), (v0.beacons.length - v1.beacons.length) + ' vs ' + union);
    check('the two are one area', BL.areas(app.state.supportBlockers).length === 1);
    withBoxes(app, [[[-5, -30, z - 3], [5, 30, z + 3]], [[8, -30, z - 3], [12, 30, z + 3]]]);
    app.frame(); await app.sleep(20);
    app.card.pick(id);
    const v2 = app.card.view();
    check('two that do not overlap leave the gap between them its spots', v2.beacons.some(b => b.p[0] > 5 && b.p[0] < 8) && BL.areas(app.state.supportBlockers).length === 2);
  }

  section('F  a box that holds every spot');
  {
    const { app, id } = await openBench();
    const z = app.card.view().beacons[0].p[2];
    withBoxes(app, [[[-40, -40, z - 3], [40, 40, z + 3]]]);
    app.frame(); await app.sleep(20);
    app.card.pick(id);
    check('the card says every spot is inside a blocker', /Every spot is inside a Supports Blocker/.test(app.head()), app.head());
    check('the state is "nothing" and Generate is off', app.card.view().state === 'nothing' && app.el('btn-sup-all').disabled === true);
    const r = await app.ctx.NSO_SUPPORTS_CARD.generate();
    check('a build adds nothing', !r.ok && app.allSupports().length === 0 && app.state.undoStack.length === 0, JSON.stringify(r).slice(0, 120));
  }

  section('G  Generate for plate');
  {
    const app = lib.makeApp();
    const ids = app.load([lib.shape('bench A', lib.benchSoup(60, 30, 20, 8)), lib.shape('bench B', lib.benchSoup(60, 30, 20, 8))]);
    app.openCard(); app.frame(); await app.sleep(30);
    app.setPlateBox(true);
    await app.until(() => app.card.plateView() && !app.card.plateView().pending, 60000);
    const before = app.card.plateView();
    const spotsBefore = before.pieces.map(p => p.spots);
    // a box across the first piece's underside only
    const a = app.placedOf(ids[0]), box = new app.THREE.Box3().setFromObject(a.mesh);
    withBoxes(app, [[[box.min.x - 1, -box.max.z - 1, 10], [box.max.x + 1, -box.min.z + 1, 40]]]);
    app.frame(); await app.sleep(40);
    await app.until(() => app.card.plateView() && !app.card.plateView().pending, 60000);
    const after = app.card.plateView();
    check('the plate\'s line counts the spots the box holds', / · \d+ spots blocked/.test(after.count) && after.totals.blocked > 0, after.count);
    check('...the piece it is round has none left to build, the other keeps all', after.pieces[0].spots === 0 && after.pieces[1].spots === spotsBefore[1], JSON.stringify(after.pieces.map(p => p.spots)) + ' was ' + JSON.stringify(spotsBefore));
  }

  section('H  Slice and Preview');
  {
    const { app } = await openBench();
    const log = [];
    let release = null;
    const stub = {
      sliceAndPreview(hook) {
        log.push('slice');
        hook.onStage('Slicing 2 objects - 3 s');
        return new Promise(go => { release = r => { hook.onDone && hook.onDone(r); go(r); }; });
      },
      cancel() { log.push('cancel'); release({ ok: false, reason: 'Slice cancelled.', cancelled: true, previewed: false }); }
    };
    app.ctx.NSO_Print = { card: stub };
    app.el('menu-supports').open = true;
    const p1 = app.ctx.NSO_SUPPORTS_CARD.sliceAndPreview();
    check('pressed: the slice starts, the card locks Slice and Generate, Cancel shows, the stage line is the Slice card\'s',
      log[0] === 'slice' && app.el('btn-sup-slice').disabled === true && app.el('btn-sup-slice').textContent === 'Slicing…' && app.el('btn-sup-slice-cancel').hidden === false &&
      app.el('sup-slice-line').textContent === 'Slicing 2 objects - 3 s' && app.el('btn-sup-all').disabled === true && app.ctx.NSO_SUPPORTS_CARD.sliceBusy(), app.el('sup-slice-line').textContent);
    const p2 = await app.ctx.NSO_SUPPORTS_CARD.sliceAndPreview();
    check('...pressed again, it is busy and starts nothing', p2.reason === 'busy' && log.length === 1);
    const g = await app.ctx.NSO_SUPPORTS_CARD.generate();
    check('...and a Generate is refused while it runs', !g.ok && g.reason === 'busy');
    app.ctx.NSO_SUPPORTS_CARD.cancelSlice();
    const r1 = await p1;
    check('Cancel stops it: the Slice card is told, the line says so (not as an error), the button is back', log[1] === 'cancel' && r1.cancelled && app.el('sup-slice-line').textContent === 'Slice cancelled.' &&
      !app.el('sup-slice-line').classList.contains('is-bad') && app.el('btn-sup-slice').disabled === false && app.el('btn-sup-slice').textContent === 'Slice and Preview' && app.el('btn-sup-slice-cancel').hidden === true);
    const p3 = app.ctx.NSO_SUPPORTS_CARD.sliceAndPreview();
    release({ ok: false, reason: 'Slice refused: the plate has nothing on it', previewed: false });
    await p3;
    check('a refusal is said in red, in the Slice card\'s words, and the card stays open', app.el('sup-slice-line').textContent === 'Slice refused: the plate has nothing on it' &&
      app.el('sup-slice-line').classList.contains('is-bad') && app.el('menu-supports').open === true);
    const p4 = app.ctx.NSO_SUPPORTS_CARD.sliceAndPreview();
    release({ ok: true, line: '38 layers', previewed: true });
    await p4;
    check('a slice that is opened in G-scope puts the line away and closes the card (G-scope has the view)', app.el('sup-slice-line').hidden === true && app.el('menu-supports').open === false);
    app.ctx.NSO_Print = undefined;
    app.el('menu-supports').open = true;
    const p5 = await app.ctx.NSO_SUPPORTS_CARD.sliceAndPreview();
    check('with no slicer loaded it says so', !p5.ok && /did not load/.test(app.el('sup-slice-line').textContent));
  }

  console.log('\n' + (fails ? fails + ' FAILED' : 'all gates held'));
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
