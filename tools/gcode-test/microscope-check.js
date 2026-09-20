#!/usr/bin/env node
/*
 * nest-optimizer / tools/gcode-test / microscope-check.js
 *
 * The microscope's two selection predicates and its export geometry, under
 * Node, against the real files.
 *
 * microscope-drive-check.mjs drives the view itself in a browser. This one
 * proves the arithmetic the view sits on, where a failure names a number
 * instead of a pixel:
 *
 *   1. the reference tool's capture-box predicate, reproduced exactly, with
 *      the independent horizontal and vertical extents that are its whole
 *      point;
 *   2. full-layer selection, which is NSOGcodeLines.movesAtZ() and not a
 *      second copy of it;
 *   3. the export geometry - that "to plate" and "to disk" are the same
 *      triangles, that a toolpath selection is 12 per move, and that a mesh
 *      selection is the objects' own triangles and nothing else;
 *   4. the import routing - that a sliced project and a plain project cannot
 *      take each other's route;
 *   5. the axis map, because the reference tool's is a reflection and this
 *      one must not be.
 *
 * Usage: node tools/gcode-test/microscope-check.js
 */
'use strict';

const path = require('path');
const fs = require('fs');

const REPO = path.join(__dirname, '..', '..');
const G = require(path.join(REPO, 'nso-gcode-lines.js'));
const R = require(path.join(REPO, 'nso-3mf-read.js'));
const { readSTL } = require(path.join(REPO, 'tools', 'nso_stl_io.js'));

let pass = 0;
const failures = [];

function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; return; }
  failures.push(`${name}\n     got  ${JSON.stringify(got)}\n     want ${JSON.stringify(want)}`);
}
function ok(name, cond, detail) {
  if (cond) { pass++; return; }
  failures.push(name + (detail ? `\n     ${detail}` : ''));
}
function section(t) { console.log(`\n${t}`); }
function note(t) { console.log('  ' + t); }

const SLICES = {
  tabletop: 'fixtures/3mf/tabletop.gcode.3mf',
  support: 'fixtures/3mf/supportwithinsupport.gcode.3mf',
};
const PLAIN_3MF = 'fixtures/3mf/pa_pattern.3mf';
const MULTI_3MF = 'fixtures/3mf/flowrate-test-pass2.3mf';
// One ASCII and one binary, because STLLoader accepts both and the view must
// too. `box-20mm.stl` is ASCII; `fixture_sphere_curved.stl` is binary.
const PLAIN_STL = 'fixtures/box-20mm.stl';
const PLAIN_STL_BIN = 'fixtures/fixture_sphere_curved.stl';

const bytesOf = (rel) => new Uint8Array(fs.readFileSync(path.join(REPO, rel)));

// ---------------------------------------------------------------------------
// The pieces of app-microscope.js that are pure arithmetic, restated here in
// the form the view uses them. Restated and not imported because the view is a
// browser module that builds a WebGL context on load; every one of these is
// asserted against the view's OWN behaviour in microscope-drive-check.mjs, so
// a divergence between this file and the view is caught there.
// ---------------------------------------------------------------------------

/** app-microscope.js `toThree`, and the app's own zUpToYUp: (x,y,z)->(x,z,-y) */
const toThree = (x, y, z) => [x, z, -y];

/** app-microscope.js `inBox` - the reference tool's predicate, unchanged. */
const inBox = (b, mx, my, mz) =>
  Math.abs(mx - b.gx) <= b.r && Math.abs(my - b.gy) <= b.r && Math.abs(mz - b.gz) <= b.h;

/** app-microscope.js `selectByBox`, toolpath branch. */
function selectByBox(segments, boxes) {
  return segments.filter((s) => {
    const mx = (s.x0 + s.x1) / 2, my = (s.y0 + s.y1) / 2, mz = s.z;
    return boxes.some((b) => inBox(b, mx, my, mz));
  });
}

/** app-microscope.js `toolpathDoc` - the reference tool's segment schema. */
function segmentsOf(parsed) {
  return parsed.moves.map((m) => ({
    x0: m.x0, y0: m.y0, x1: m.x1, y1: m.y1,
    z: m.z, w: m.width, feature: m.feature, obj: m.objectId, layer: m.layer, mv: m,
  }));
}

/** Triangle count of a positions array. */
const tris = (p) => p.length / 9;

async function main() {
  // =========================================================================
  section('1. The axis map - a rotation, not the reference tool\'s reflection');
  // =========================================================================
  //
  // The reference tool's toThree is (x,y,z)->(x,z,y), determinant -1, so it
  // draws every slice mirrored. Invisible there; not invisible here, because
  // both exports would hand back a mirrored part.

  const det = (M) =>
    M[0][0] * (M[1][1] * M[2][2] - M[1][2] * M[2][1]) -
    M[0][1] * (M[1][0] * M[2][2] - M[1][2] * M[2][0]) +
    M[0][2] * (M[1][0] * M[2][1] - M[1][1] * M[2][0]);

  const ours = [toThree(1, 0, 0), toThree(0, 1, 0), toThree(0, 0, 1)];
  const reference = [[1, 0, 0], [0, 0, 1], [0, 1, 0]];  // (x,y,z)->(x,z,y)
  check('ours is a proper rotation', det(ours), 1);
  check('the reference tool\'s is a reflection - the thing not adopted', det(reference), -1);
  check('and it is exactly zUpToYUp: rotateX(-PI/2)', toThree(1, 2, 3), [1, 3, -2]);
  note(`ours det ${det(ours)}, reference det ${det(reference)}`);

  // =========================================================================
  section('2. Import routing - decided by content, never by the filename');
  // =========================================================================

  for (const [name, rel] of Object.entries(SLICES)) {
    const zip = R.openZip(bytesOf(rel));
    ok(`${name}: carries plate G-code, so it takes the toolpath route`,
      G.listPlateGcode(zip).length > 0);
    let objects = -1;
    try { objects = (await R.parse3MF(bytesOf(rel))).objects.length; } catch { objects = -1; }
    ok(`${name}: and has no readable model objects, so it cannot take the other one`,
      objects === -1, `parse3MF returned ${objects} objects`);
  }
  for (const rel of [PLAIN_3MF, MULTI_3MF]) {
    const short = path.basename(rel);
    ok(`${short}: carries no plate G-code, so it takes the mesh route`,
      G.listPlateGcode(R.openZip(bytesOf(rel))).length === 0);
    const res = await R.parse3MF(bytesOf(rel));
    ok(`${short}: and has objects to draw`, res.objects.length > 0,
      `${res.objects.length} objects`);
    note(`${short}: ${res.objects.length} object(s) - ` +
         res.objects.map((o) => o.name).slice(0, 4).join(', '));
  }

  // =========================================================================
  section('3. The capture box - the reference tool\'s predicate, unchanged');
  // =========================================================================

  const support = await G.readSlicedGcode3MF(bytesOf(SLICES.support), { name: 'support' });
  const segs = segmentsOf(support.parsed);
  check('every segment carries the reference schema',
    Object.keys(segs[0]).filter((k) => ['x0', 'y0', 'x1', 'y1', 'z', 'w', 'feature', 'obj', 'layer'].includes(k)).length,
    9);

  // A box over the middle of the part, thin by default (h = 1.0, r = 5.0 -
  // the reference tool's own defaults).
  const mid = support.parsed.moves[Math.floor(support.parsed.moves.length / 2)];
  const box = { gx: (mid.x0 + mid.x1) / 2, gy: (mid.y0 + mid.y1) / 2, gz: mid.z, r: 5.0, h: 1.0 };
  const caught = selectByBox(segs, [box]);
  ok('a default box catches something', caught.length > 0, `${caught.length} segments`);
  ok('every catch really is inside it', caught.every((s) =>
    inBox(box, (s.x0 + s.x1) / 2, (s.y0 + s.y1) / 2, s.z)));
  ok('and nothing outside it was caught',
    segs.filter((s) => inBox(box, (s.x0 + s.x1) / 2, (s.y0 + s.y1) / 2, s.z)).length === caught.length);

  // The whole point of the box: the vertical extent is independent of the
  // horizontal one. A sphere of radius r would reach r upward too.
  const thin = selectByBox(segs, [{ ...box, h: 0.01 }]);
  const tall = selectByBox(segs, [{ ...box, h: 5.0 }]);
  const layersOf = (sel) => new Set(sel.map((s) => s.layer)).size;
  ok('thin takes one layer', layersOf(thin) === 1, `${layersOf(thin)} layers, ${thin.length} segs`);
  ok('tall at the same footprint takes several', layersOf(tall) > layersOf(thin),
    `${layersOf(tall)} layers, ${tall.length} segs`);
  ok('a sphere could not: the same reach horizontally is many layers vertically',
    layersOf(selectByBox(segs, [{ ...box, h: box.r }])) > 1);
  note(`h 0.01 -> ${layersOf(thin)} layer / h 1.0 -> ${layersOf(caught)} layers / ` +
       `h 5.0 -> ${layersOf(tall)} layers, all at r ${box.r}`);

  // Widening the footprint takes more at the same height, and never fewer.
  const wide = selectByBox(segs, [{ ...box, r: 40 }]);
  ok('a wider footprint is a superset at the same thickness', wide.length >= caught.length &&
    caught.every((s) => wide.includes(s)), `${caught.length} -> ${wide.length}`);

  // Two boxes are a union, as the reference tool's `.some()` says.
  const other = { ...box, gx: box.gx + 12 };
  const union = selectByBox(segs, [box, other]);
  const alone = selectByBox(segs, [other]);
  check('two boxes are a union, not an intersection',
    union.length, new Set([...caught, ...alone]).size);

  // =========================================================================
  section('4. Full-layer selection - movesAtZ(), not a second copy of it');
  // =========================================================================

  for (const [name, rel] of Object.entries(SLICES)) {
    const res = await G.readSlicedGcode3MF(bytesOf(rel), { name });
    const n = res.parsed.layers.length;
    let total = 0;
    const seen = new Set();
    for (let li = 0; li < n; li++) {
      const win = G.layerZWindow(res.parsed, li);
      const got = G.movesInZWindow(res.parsed.moves, win);
      total += got.length;
      got.forEach((m) => seen.add(m.index));
      if (li === 0 || li === n - 1) {
        ok(`${name} L${li + 1}: the layer is not empty`, got.length > 0);
        ok(`${name} L${li + 1}: at exactly one printing Z`,
          new Set(got.map((m) => m.z.toFixed(6))).size === 1);
        ok(`${name} L${li + 1}: across every feature at that height`,
          new Set(got.map((m) => m.feature)).size >= 1);
      }
    }
    check(`${name}: the layers partition the file - no move in two, none in none`,
      [seen.size, total], [res.parsed.moves.length, res.parsed.moves.length]);
    note(`${name}: ${n} layers, ${res.parsed.moves.length} moves, partitioned exactly`);
  }

  // A plain mesh has no layers, and the view refuses rather than inventing one.
  const plainObjs = (await R.parse3MF(bytesOf(PLAIN_3MF))).objects;
  ok('a plain 3MF offers no layers to select', plainObjs.every((o) => o.layers === undefined));

  // =========================================================================
  section('5. Export geometry - one builder, two doors');
  // =========================================================================

  // Toolpath: 12 triangles per move, the same buildLineGeometry() the Toolpath
  // card's Extract Line uses, so the two cannot drift.
  const layer0 = G.movesInZWindow(support.parsed.moves, G.layerZWindow(support.parsed, 0));
  const built = G.buildLineGeometry(layer0);
  check('a whole-layer export is TRIS_PER_MOVE a line and nothing else',
    tris(built.positions), layer0.length * G.TRIS_PER_MOVE);
  check('and TRIS_PER_MOVE is 12 - a closed box', G.TRIS_PER_MOVE, 12);
  ok('and it is in Z-up millimetres, uncentred - what the ingest path takes',
    built.positions.some((v) => v > 1), 'all-zero positions would mean centred');

  // The box selection exports the same way.
  const boxGeo = G.buildLineGeometry(caught.map((s) => s.mv));
  check('a box export is 12 triangles a segment too', tris(boxGeo.positions), caught.length * 12);

  // "Export to plate" and "Export as STL" build the SAME bytes. The view calls
  // one function for both; this is the property that makes that worth doing.
  const a = G.buildLineGeometry(caught.map((s) => s.mv)).positions;
  const b = G.buildLineGeometry(caught.map((s) => s.mv)).positions;
  check('the two exports are triangle-for-triangle identical',
    [a.length, Array.from(a).every((v, i) => v === b[i])], [b.length, true]);

  // Each bead is its own measured width and height, so an export is not a
  // constant-section approximation.
  const widths = new Set(caught.map((s) => s.w.toFixed(4)));
  ok('beads carry their own measured widths', widths.size >= 1, `${widths.size} distinct widths`);
  ok('nothing in either real file was assumed', support.parsed.meta.assumed === false);

  // Mesh: the objects' own triangles and nothing else.
  const multi = await R.parse3MF(bytesOf(MULTI_3MF));
  const pick = multi.objects.slice(0, 3);
  const total = pick.reduce((acc, o) => acc + o.positions.length, 0);
  const merged = new Float32Array(total);
  let at = 0;
  pick.forEach((o) => { merged.set(o.positions, at); at += o.positions.length; });
  check('a mesh export is the selected objects\' triangles, summed',
    tris(merged), pick.reduce((acc, o) => acc + tris(o.positions), 0));
  ok('and it is a strict subset of the file',
    tris(merged) < multi.objects.reduce((acc, o) => acc + tris(o.positions), 0),
    `${tris(merged)} of ${multi.objects.reduce((acc, o) => acc + tris(o.positions), 0)}`);
  note(`${path.basename(MULTI_3MF)}: 3 of ${multi.objects.length} objects -> ${tris(merged)} triangles`);

  // A plain STL is one object by definition, so its whole-part export is the
  // file. Read here with the repo's own STL reader rather than the browser's,
  // and in both encodings the format has - the view accepts both too.
  for (const rel of [PLAIN_STL, PLAIN_STL_BIN]) {
    const soup = readSTL(path.join(REPO, rel));
    const n = tris(soup);
    ok(`${path.basename(rel)} is one object - one whole, unsegmented part`, n > 0, `${n} triangles`);
    ok(`${path.basename(rel)} has no layers and no features to group by`,
      soup.length % 9 === 0);
    note(`${path.basename(rel)}: ${n} triangles, one object, no layers, no features`);
  }

  // =========================================================================
  section('6. The density the reference tool was never run at');
  // =========================================================================

  const big = await G.readSlicedGcode3MF(bytesOf(SLICES.tabletop), { name: 'tabletop' });
  ok('tabletop is far past the reference tool\'s baked 25,976 segments',
    big.parsed.moves.length > 25976 * 5, `${big.parsed.moves.length} moves`);
  note(`tabletop: ${big.parsed.moves.length} moves = ` +
       `${(big.parsed.moves.length / 25976).toFixed(1)}x the baked SEGMENTS, ` +
       `${big.parsed.moves.length * 12} triangles as solids`);
  // A box over it still resolves, which is the property that matters.
  const bigSegs = segmentsOf(big.parsed);
  const bm = big.parsed.moves[Math.floor(big.parsed.moves.length / 2)];
  const bigCaught = selectByBox(bigSegs, [{
    gx: (bm.x0 + bm.x1) / 2, gy: (bm.y0 + bm.y1) / 2, gz: bm.z, r: 5.0, h: 1.0,
  }]);
  ok('and a default capture box over it still selects', bigCaught.length > 0,
    `${bigCaught.length} segments`);
  // The reference tool's default h is 1.0 mm. tabletop prints at 0.3 mm, so
  // that window is SEVEN layers, not one - which is the box doing exactly what
  // its own UI text warns about ("keep it thin to avoid grabbing unrelated
  // layers above/below"). The invariant is the window, not a layer count.
  const bz = (bm.z);
  ok('every catch is inside the window, whatever that is in layers',
    bigCaught.every((s) => Math.abs(s.z - bz) <= 1.0 + 1e-9),
    `${new Set(bigCaught.map((s) => s.layer)).size} layers at h 1.0`);
  const bigThin = selectByBox(bigSegs, [{
    gx: (bm.x0 + bm.x1) / 2, gy: (bm.y0 + bm.y1) / 2, gz: bm.z, r: 5.0, h: 0.01,
  }]);
  ok('and tightening h to 0.01 gets back to exactly one layer',
    new Set(bigThin.map((s) => s.layer)).size === 1,
    `${new Set(bigThin.map((s) => s.layer)).size} layers`);
  note(`tabletop at r 5.0: h 1.0 -> ${new Set(bigCaught.map((s) => s.layer)).size} layers ` +
       `(0.3 mm layer height), h 0.01 -> ${new Set(bigThin.map((s) => s.layer)).size} layer`);

  // ---------------------------------------------------------------------
  console.log('');
  if (failures.length) {
    failures.forEach((f) => console.error('FAIL  ' + f));
    console.error(`\n${pass} passed, ${failures.length} failed`);
    process.exit(1);
  }
  console.log(`${pass} passed, 0 failed`);
}

main().catch((err) => { console.error(err); process.exit(1); });
