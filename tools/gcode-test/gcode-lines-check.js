#!/usr/bin/env node
/*
 * nso-gcode-lines.js check suite - dependency free, no browser.
 *
 * Three tiers, in order of how much they prove:
 *
 *  1. FLOW MODEL. widthFromExtrusion / areaFromWidth are exact inverses, and
 *     the width formula is the published stadium cross-section, checked against
 *     hand-computed numbers.
 *  2. GROUND TRUTH. fixtures/3mf/toolpath-ground-truth.gcode.3mf is written by
 *     make-fixture.js from a table of known widths and angles; every move read
 *     back must match the width, height, angle, length and feature it was
 *     written with, and the built geometry must MEASURE that width and angle.
 *     Nothing here is a default: the check asserts meta.assumed is false.
 *  3. REAL FILE. The same measurements over real Bambu Studio slices. Two are
 *     committed (fixtures/3mf/tabletop.gcode.3mf and
 *     supportwithinsupport.gcode.3mf) so this tier runs by default;
 *     NSO_GCODE_REAL=/path/to/a.gcode.3mf points it at others instead. The
 *     hand-verified measurements off those two files live in
 *     tools/gcode-test/gcode-zfilter-check.js.
 *
 * Run: node tools/gcode-test/gcode-lines-check.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const G = require('../../nso-gcode-lines.js');

const REPO = path.join(__dirname, '..', '..');
let pass = 0, fail = 0;
const failures = [];

function ok(cond, what) {
  if (cond) { pass++; } else { fail++; failures.push(what); console.log('  FAIL ' + what); }
}
function near(a, b, eps, what) {
  const d = Math.abs(a - b);
  ok(d <= eps, what + ' (got ' + a + ', want ' + b + ', delta ' + d.toExponential(2) + ')');
}
function section(t) { console.log('\n' + t); }

// ===========================================================================
section('1. Flow model');
// ===========================================================================
{
  // Exact inverses over a realistic spread of widths and heights.
  let worst = 0;
  for (const h of [0.08, 0.12, 0.2, 0.28, 0.3]) {
    for (const w of [0.3, 0.38, 0.42, 0.45, 0.6, 0.8]) {
      if (w <= h) continue;
      const area = G.areaFromWidth(w, h);
      const dist = 12.345;
      const dE = area * dist / (Math.PI * 1.75 * 1.75 / 4);
      const back = G.widthFromExtrusion(dE, dist, h, 1.75);
      worst = Math.max(worst, Math.abs(back - w));
    }
  }
  ok(worst < 1e-12, 'width -> E -> width round-trips exactly (worst ' + worst.toExponential(2) + ')');

  // A hand-computable case: a square cross-section of w = h has area
  // h*(h-h) + PI h^2/4 = PI h^2 / 4, i.e. a pure semicircle pair.
  near(G.areaFromWidth(0.2, 0.2), Math.PI * 0.04 / 4, 1e-15, 'w = h gives the circular area');

  // Width scales linearly with E once h and distance are fixed, because the
  // stadium term is constant. Doubling E raises w by exactly area/h.
  const h = 0.2, dist = 10, filArea = Math.PI * 1.75 * 1.75 / 4;
  const w1 = G.widthFromExtrusion(0.3, dist, h, 1.75);
  const w2 = G.widthFromExtrusion(0.6, dist, h, 1.75);
  near(w2 - w1, (0.3 * filArea / dist) / h, 1e-12, 'width is linear in E at fixed h');

  // Degenerate inputs produce no line rather than a NaN.
  ok(G.widthFromExtrusion(0, 10, 0.2, 1.75) === 0, 'zero E -> no width');
  ok(G.widthFromExtrusion(-0.5, 10, 0.2, 1.75) === 0, 'retraction -> no width');
  ok(G.widthFromExtrusion(0.3, 0, 0.2, 1.75) === 0, 'zero distance -> no width');
  ok(G.widthFromExtrusion(0.3, 10, 0, 1.75) === 0, 'zero height -> no width');
}

// ===========================================================================
section('2. Parser state machine');
// ===========================================================================
{
  const filArea = Math.PI * 1.75 * 1.75 / 4;
  const eFor = (w, h, d) => G.areaFromWidth(w, h) * d / filArea;

  // Relative E (M83), Bambu's mode.
  const rel = G.parseGcode([
    'G90', 'M83', 'G92 E0',
    '; CHANGE_LAYER', '; Z_HEIGHT: 0.2', '; LAYER_HEIGHT: 0.2',
    '; FEATURE: Outer wall',
    'G1 X0 Y0 F12000',
    'G1 X10 Y0 E' + eFor(0.42, 0.2, 10),
    '; filament_diameter = 1.75'
  ].join('\n'));
  ok(rel.moves.length === 1, 'M83: one extrusion move');
  near(rel.moves[0].width, 0.42, 1e-9, 'M83: width recovered');
  ok(rel.meta.absoluteE === false && rel.meta.eModeFromFile, 'M83 detected from the file');

  // Absolute E (M82): the same physical move written as a running total.
  const e1 = eFor(0.42, 0.2, 10);
  const abs = G.parseGcode([
    'G90', 'M82', 'G92 E0',
    '; CHANGE_LAYER', '; Z_HEIGHT: 0.2', '; LAYER_HEIGHT: 0.2',
    '; FEATURE: Outer wall',
    'G1 X0 Y0 F12000',
    'G1 X10 Y0 E' + e1,
    'G1 X10 Y10 E' + (e1 + e1),
    '; filament_diameter = 1.75'
  ].join('\n'));
  ok(abs.moves.length === 2, 'M82: two extrusion moves');
  near(abs.moves[0].width, 0.42, 1e-9, 'M82: first width recovered');
  near(abs.moves[1].width, 0.42, 1e-9, 'M82: second width from the E DELTA, not the total');
  ok(abs.meta.absoluteE === true, 'M82 detected from the file');

  // Travels, retractions and Z hops are not lines.
  const noise = G.parseGcode([
    'G90', 'M83', 'G92 E0',
    '; CHANGE_LAYER', '; Z_HEIGHT: 0.2', '; LAYER_HEIGHT: 0.2',
    '; FEATURE: Outer wall',
    'G1 X0 Y0 F12000',
    'G1 E0.8 F1800',            // prime, no XY
    'G1 Z5 F12000',             // hop
    'G1 X10 Y0 F12000',         // travel, no E
    'G1 Z0.2 F12000',
    'G1 E-0.8 F1800',           // retract
    'G0 X20 Y0 E1',             // G0 with E - still a move, kept
    '; filament_diameter = 1.75'
  ].join('\n'));
  ok(noise.moves.length === 0, 'travel, prime, retract and Z hop produce no lines');

  // G92 E0 mid-file must not be read as a huge negative extrusion.
  const reset = G.parseGcode([
    'G90', 'M82', 'G92 E0',
    '; CHANGE_LAYER', '; Z_HEIGHT: 0.2', '; LAYER_HEIGHT: 0.2',
    '; FEATURE: Inner wall',
    'G1 X0 Y0 F12000',
    'G1 X10 Y0 E' + e1,
    'G92 E0',
    'G1 X10 Y10 E' + e1,
    '; filament_diameter = 1.75'
  ].join('\n'));
  ok(reset.moves.length === 2, 'G92 E0: both moves kept');
  near(reset.moves[1].width, 0.42, 1e-9, 'G92 E0 rebases the extruder, no phantom width');

  // Feature grouping, and the layer index.
  const grouped = G.parseGcode([
    'G90', 'M83', 'G92 E0',
    '; CHANGE_LAYER', '; Z_HEIGHT: 0.2', '; LAYER_HEIGHT: 0.2',
    '; FEATURE: Outer wall',
    'G1 X0 Y0 F12000', 'G1 X10 Y0 E' + eFor(0.42, 0.2, 10),
    '; FEATURE: Support interface',
    'G1 X0 Y5 F12000', 'G1 X10 Y5 E' + eFor(0.40, 0.2, 10),
    '; CHANGE_LAYER', '; Z_HEIGHT: 0.4', '; LAYER_HEIGHT: 0.2',
    '; FEATURE: Outer wall',
    'G1 X0 Y0 F12000', 'G1 X10 Y0 E' + eFor(0.42, 0.2, 10),
    '; filament_diameter = 1.75'
  ].join('\n'));
  ok(grouped.features.length === 2, 'two feature groups');
  ok(grouped.features.map(f => f.name).join('|') === 'Outer wall|Support interface',
     'feature groups keep print order');
  ok(grouped.features[0].moves.length === 2, 'Outer wall spans both layers');
  ok(grouped.layers.length === 2, 'two layers');
  ok(grouped.moves[2].layer === 1, 'layer 2 moves carry layer index 1');
  near(grouped.moves[2].z, 0.4, 1e-12, 'layer 2 prints at its Z_HEIGHT');
  near(grouped.moves[1].width, 0.40, 1e-9, 'Support interface width recovered');

  // Height from the measured Z step when the file names no LAYER_HEIGHT.
  const noTag = G.parseGcode([
    'G90', 'M83', 'G92 E0',
    '; CHANGE_LAYER', '; Z_HEIGHT: 0.2',
    '; FEATURE: Outer wall',
    'G1 X0 Y0 F12000', 'G1 X10 Y0 E' + eFor(0.42, 0.2, 10),
    '; CHANGE_LAYER', '; Z_HEIGHT: 0.45',
    '; FEATURE: Outer wall',
    'G1 X0 Y0 F12000', 'G1 X10 Y0 E1',
    '; filament_diameter = 1.75'
  ].join('\n'));
  near(noTag.moves[0].height, 0.2, 1e-12, 'first layer height is its own Z');
  ok(noTag.moves[0].heightSource === 'firstLayer', 'first-layer height source reported');
  near(noTag.moves[1].height, 0.25, 1e-12, 'later layer height is the measured Z step');
  ok(noTag.moves[1].heightSource === 'zstep', 'Z-step height source reported');

  // A file that names nothing is honest about it.
  const bare = G.parseGcode([
    '; CHANGE_LAYER', '; FEATURE: Outer wall',
    'G1 X0 Y0 F12000', 'G1 X10 Y0 E1'
  ].join('\n'));
  ok(bare.meta.assumed === true, 'a file with no settings is flagged as assumed');
  ok(bare.warnings.some(w => /filament_diameter/.test(w)), 'missing filament_diameter warned');
  ok(bare.warnings.some(w => /M82 nor M83/.test(w)), 'missing E mode warned');

  // Arc moves flatten into chords that carry the extrusion by length.
  const arc = G.parseGcode([
    'G90', 'M83', 'G92 E0',
    '; CHANGE_LAYER', '; Z_HEIGHT: 0.2', '; LAYER_HEIGHT: 0.2',
    '; FEATURE: Outer wall',
    'G1 X10 Y0 F12000',
    'G3 X0 Y10 I-10 J0 E' + eFor(0.42, 0.2, Math.PI * 10 / 2),
    '; filament_diameter = 1.75'
  ].join('\n'));
  ok(arc.moves.length > 20, 'G3 flattened into chords (' + arc.moves.length + ')');
  const arcLen = arc.moves.reduce((s, m) => s + m.length, 0);
  near(arcLen, Math.PI * 10 / 2, 0.02, 'chords recover the arc length');
  const arcW = arc.moves.reduce((s, m) => s + m.width, 0) / arc.moves.length;
  near(arcW, 0.42, 2e-3, 'chord widths match the arc width');
}

// ===========================================================================
section('3. Flat-line geometry');
// ===========================================================================
{
  const mv = { index: 0, x0: 0, y0: 0, x1: 10, y1: 0, z: 0.2, width: 0.42, height: 0.2 };
  const p = G.extrudeFlatLine(mv);
  ok(p.length === 12 * 9, '12 triangles per move');

  const xs = [], ys = [], zs = [];
  for (let i = 0; i < p.length; i += 3) { xs.push(p[i]); ys.push(p[i + 1]); zs.push(p[i + 2]); }
  near(Math.max(...ys) - Math.min(...ys), 0.42, 1e-7, 'measured width across the move = 0.42');
  near(Math.max(...zs) - Math.min(...zs), 0.2, 1e-7, 'measured height = 0.2');
  near(Math.max(...zs), 0.2, 1e-7, 'the nozzle Z is the TOP of the bead');
  near(Math.min(...zs), 0.0, 1e-7, 'the bead sits on the layer below');
  near(Math.max(...xs) - Math.min(...xs), 10, 1e-6, 'measured length = 10');

  // Closed shell: every undirected edge used exactly twice.
  function edgeCheck(pos) {
    const key = (a, b) => a < b ? a + '|' + b : b + '|' + a;
    const vid = new Map(); const ids = [];
    for (let i = 0; i < pos.length; i += 3) {
      const k = pos[i].toFixed(6) + ',' + pos[i + 1].toFixed(6) + ',' + pos[i + 2].toFixed(6);
      if (!vid.has(k)) vid.set(k, vid.size);
      ids.push(vid.get(k));
    }
    const counts = new Map();
    for (let t = 0; t < ids.length; t += 3) {
      for (const [a, b] of [[0, 1], [1, 2], [2, 0]]) {
        const k = key(ids[t + a], ids[t + b]);
        counts.set(k, (counts.get(k) || 0) + 1);
      }
    }
    let bad = 0; counts.forEach(c => { if (c !== 2) bad++; });
    return { verts: vid.size, badEdges: bad };
  }
  const ec = edgeCheck(p);
  ok(ec.verts === 8, 'the shell has 8 distinct corners');
  ok(ec.badEdges === 0, 'the shell is closed - every edge used twice');

  // Signed volume is positive, i.e. the winding faces outwards.
  function signedVolume(pos) {
    let v = 0;
    for (let i = 0; i < pos.length; i += 9) {
      const [ax, ay, az, bx, by, bz, cx, cy, cz] = pos.slice(i, i + 9);
      v += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
    }
    return v;
  }
  near(signedVolume(p), 10 * 0.42 * 0.2, 1e-6, 'signed volume = length x width x height, positive');

  // A 30-degree move measures 30 degrees, and its width is still across.
  const ang = Math.PI / 6;
  const d = 8;
  const mv2 = { index: 1, x0: 1, y0: 2, x1: 1 + d * Math.cos(ang), y1: 2 + d * Math.sin(ang),
                z: 0.4, width: 0.45, height: 0.2 };
  const p2 = G.extrudeFlatLine(mv2);
  // Project the corners onto the along / across axes and measure the extents.
  const ux = Math.cos(ang), uy = Math.sin(ang), nx = -uy, ny = ux;
  let aMin = Infinity, aMax = -Infinity, cMin = Infinity, cMax = -Infinity;
  for (let i = 0; i < p2.length; i += 3) {
    const rx = p2[i] - mv2.x0, ry = p2[i + 1] - mv2.y0;
    const along = rx * ux + ry * uy, across = rx * nx + ry * ny;
    aMin = Math.min(aMin, along); aMax = Math.max(aMax, along);
    cMin = Math.min(cMin, across); cMax = Math.max(cMax, across);
  }
  near(aMax - aMin, d, 1e-6, '30-degree move: measured length = 8');
  near(cMax - cMin, 0.45, 1e-7, '30-degree move: measured width across = 0.45');
  near(Math.atan2(mv2.y1 - mv2.y0, mv2.x1 - mv2.x0) * 180 / Math.PI, 30, 1e-9,
       '30-degree move: measured angle = 30 degrees');

  // Triangle -> move mapping, which is what picking in the viewport needs.
  const built = G.buildLineGeometry([mv, mv2]);
  ok(built.positions.length === 2 * 12 * 9, 'two moves -> 24 triangles');
  ok(G.moveOfTriangle(built, 0) === 0 && G.moveOfTriangle(built, 11) === 0,
     'triangles 0..11 belong to move 0');
  ok(G.moveOfTriangle(built, 12) === 1 && G.moveOfTriangle(built, 23) === 1,
     'triangles 12..23 belong to move 1');
  ok(G.moveOfTriangle(built, 24) === -1, 'past the end -> no move');
}

// ===========================================================================
section('4. Ground-truth fixture, end to end');
// ===========================================================================
const FIXTURE = path.join(REPO, 'fixtures', '3mf', 'toolpath-ground-truth.gcode.3mf');
const EXPECTED = FIXTURE.replace(/\.3mf$/, '.expected.json');

async function groundTruth() {
  if (!fs.existsSync(FIXTURE) || !fs.existsSync(EXPECTED)) {
    fail++; failures.push('ground-truth fixture missing - run node tools/gcode-test/make-fixture.js');
    console.log('  FAIL fixture missing');
    return;
  }
  const want = JSON.parse(fs.readFileSync(EXPECTED, 'utf8'));
  const bytes = new Uint8Array(fs.readFileSync(FIXTURE));
  const res = await G.readSlicedGcode3MF(bytes, { name: 'toolpath-ground-truth.gcode.3mf' });

  ok(res.part === 'Metadata/plate_1.gcode', 'read Metadata/plate_1.gcode out of the archive');
  ok(res.plate === 1, 'plate 1 picked by default');
  ok(res.parsed.meta.filamentDiameterFromFile, 'filament diameter came from the file');
  near(res.parsed.meta.filamentDiameter, want.filamentDiameter, 1e-12, 'filament diameter = 1.75');
  ok(res.parsed.meta.assumed === false,
     'NOTHING was assumed - every width, height and diameter came from the file');
  ok(res.parsed.meta.heightSources.tag === res.parsed.moves.length,
     'every height came from the file\'s own LAYER_HEIGHT tag');
  ok(res.parsed.layers.length === want.layers, want.layers + ' layers');
  ok(res.parsed.moves.length === want.moves.length,
     want.moves.length + ' extrusion moves (travels, primes and retracts dropped)');

  let wWorst = 0, aWorst = 0, lWorst = 0, zWorst = 0, hWorst = 0, featBad = 0, layBad = 0;
  for (let i = 0; i < Math.min(res.parsed.moves.length, want.moves.length); i++) {
    const got = res.parsed.moves[i], exp = want.moves[i];
    wWorst = Math.max(wWorst, Math.abs(got.width - exp.width));
    hWorst = Math.max(hWorst, Math.abs(got.height - exp.height));
    aWorst = Math.max(aWorst, Math.abs(got.angle - exp.angle));
    lWorst = Math.max(lWorst, Math.abs(got.length - exp.length));
    zWorst = Math.max(zWorst, Math.abs(got.z - exp.z));
    if (got.feature !== exp.feature) featBad++;
    if (got.layer !== exp.layer) layBad++;
  }
  ok(wWorst < 1e-4, 'every width matches the fixture (worst ' + wWorst.toExponential(2) + ' mm)');
  ok(hWorst < 1e-12, 'every height matches (worst ' + hWorst.toExponential(2) + ' mm)');
  ok(aWorst < 1e-9, 'every angle matches (worst ' + (aWorst * 180 / Math.PI).toExponential(2) + ' deg)');
  ok(lWorst < 1e-4, 'every length matches (worst ' + lWorst.toExponential(2) + ' mm)');
  ok(zWorst < 1e-9, 'every Z matches');
  ok(featBad === 0, 'every move lands in the feature the slicer tagged');
  ok(layBad === 0, 'every move lands in the right layer');

  // Groups are separately addressable, which is what "separately selectable"
  // has to mean at this layer of the stack.
  const names = res.groups.map(g => g.name);
  ok(names.includes('Support interface'), 'Support interface is its own group');
  ok(names.includes('Outer wall') && names.includes('Support'), 'walls and support are separate groups');
  const si = res.groups.find(g => g.name === 'Support interface');
  ok(si.moves.length === 3 * want.layers, 'Support interface has 3 lines on each of ' + want.layers + ' layers');
  ok(si.built.positions.length === si.moves.length * 12 * 9, 'Support interface geometry is complete');
  ok(si.moves.every(m => Math.abs(m.width - 0.40) < 1e-4), 'Support interface lines measure 0.40 mm wide');

  const total = res.groups.reduce((s, g) => s + g.moves.length, 0);
  ok(total === res.parsed.moves.length, 'the groups partition the moves - none lost, none doubled');
}

// ===========================================================================
section('5. Solidity of an extracted group - the Extract standard');
// ===========================================================================
/*
 * WHAT "WATERTIGHT" MEANS FOR A TOOLPATH OBJECT, precisely.
 *
 * A toolpath is a stack of beads, and in a real print those beads touch and
 * overlap - that is what fuses a part together. So the exported object is a
 * UNION OF TOUCHING CLOSED SOLIDS, not one manifold surface, exactly like any
 * multi-part STL. Two properties are what actually matter, and both are
 * asserted here:
 *
 *   - NO LEAKS. The whole assembly has zero open (count == 1) edges, so there
 *     is no hole anywhere for a slicer to fall through.
 *   - EVERY BEAD IS A SOLID. Each move's shell closes on itself and has
 *     positive signed volume, so none of them is inside-out or torn.
 *
 * What is NOT asserted is strict two-manifoldness over the assembly. Where one
 * bead sits squarely on the one below, their shared face is used by both
 * shells, and an edge there has count 4. `stl_watertight_check.py --odd` counts
 * that as a failure; it is not one, it is two solids in contact. Run that
 * checker WITHOUT `--odd` on these exports (the leak and degeneracy test) - see
 * docs/GCODE-TOOLPATH-IMPORT.md.
 */
async function solidity() {
  const bytes = new Uint8Array(fs.readFileSync(FIXTURE));
  const res = await G.readSlicedGcode3MF(bytes);
  const group = res.groups.find(g => g.name === 'Support interface');
  ok(!!group, 'Support interface group is there to extract');

  const pos = group.built.positions;
  const key = (a, b) => (a < b ? a + '|' + b : b + '|' + a);
  const vid = new Map(); const ids = [];
  for (let i = 0; i < pos.length; i += 3) {
    const k = pos[i].toFixed(6) + ',' + pos[i + 1].toFixed(6) + ',' + pos[i + 2].toFixed(6);
    if (!vid.has(k)) vid.set(k, vid.size);
    ids.push(vid.get(k));
  }
  const counts = new Map();
  for (let t = 0; t < ids.length; t += 3) {
    for (const [a, b] of [[0, 1], [1, 2], [2, 0]]) {
      const k = key(ids[t + a], ids[t + b]);
      counts.set(k, (counts.get(k) || 0) + 1);
    }
  }
  let open = 0, degen = 0;
  counts.forEach(c => { if (c === 1) open++; });
  for (let i = 0; i < pos.length; i += 9) {
    const ax = pos[i], ay = pos[i+1], az = pos[i+2];
    const bx = pos[i+3], by = pos[i+4], bz = pos[i+5];
    const cx = pos[i+6], cy = pos[i+7], cz = pos[i+8];
    const ux = bx-ax, uy = by-ay, uz = bz-az, vx = cx-ax, vy = cy-ay, vz = cz-az;
    const nx = uy*vz-uz*vy, ny = uz*vx-ux*vz, nz = ux*vy-uy*vx;
    if (Math.sqrt(nx*nx+ny*ny+nz*nz) / 2 < 1e-12) degen++;
  }
  ok(open === 0, 'extracted group has NO open edges - nothing leaks');
  ok(degen === 0, 'extracted group has no degenerate triangles');

  // Every bead individually: closed, and positive volume.
  let notClosed = 0, notPositive = 0, volSum = 0, wantVol = 0;
  for (let m = 0; m < group.moves.length; m++) {
    const shell = pos.subarray(m * G.FLOATS_PER_MOVE, (m + 1) * G.FLOATS_PER_MOVE);
    const sv = new Map(); const si = [];
    for (let i = 0; i < shell.length; i += 3) {
      const k = shell[i].toFixed(6) + ',' + shell[i+1].toFixed(6) + ',' + shell[i+2].toFixed(6);
      if (!sv.has(k)) sv.set(k, sv.size);
      si.push(sv.get(k));
    }
    const sc = new Map();
    for (let t = 0; t < si.length; t += 3) {
      for (const [a, b] of [[0, 1], [1, 2], [2, 0]]) {
        const k = key(si[t + a], si[t + b]);
        sc.set(k, (sc.get(k) || 0) + 1);
      }
    }
    let bad = 0; sc.forEach(c => { if (c !== 2) bad++; });
    if (bad) notClosed++;
    let vol = 0;
    for (let i = 0; i < shell.length; i += 9) {
      const [ax, ay, az, bx, by, bz, cx, cy, cz] = Array.from(shell.slice(i, i + 9));
      vol += (ax*(by*cz-bz*cy) - ay*(bx*cz-bz*cx) + az*(bx*cy-by*cx)) / 6;
    }
    if (!(vol > 0)) notPositive++;
    volSum += vol;
    wantVol += group.moves[m].length * group.moves[m].width * group.moves[m].height;
  }
  ok(notClosed === 0, 'all ' + group.moves.length + ' bead shells are closed');
  ok(notPositive === 0, 'all ' + group.moves.length + ' bead shells have positive volume - none inside-out');
  // Positions are a Float32Array, so this compares at float32 precision, not double.
  ok(Math.abs(volSum - wantVol) / wantVol < 1e-6,
     'total extracted volume = sum of length x width x height (rel. error ' +
     (Math.abs(volSum - wantVol) / wantVol).toExponential(2) + ')');

  // The extracted object contains the Support interface and NOTHING else: its
  // bounding box must sit clear of every other feature's beads.
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < pos.length; i += 3) {
    minX = Math.min(minX, pos[i]); maxX = Math.max(maxX, pos[i]);
    minY = Math.min(minY, pos[i+1]); maxY = Math.max(maxY, pos[i+1]);
  }
  const others = res.parsed.moves.filter(m => m.feature !== 'Support interface');
  const strayInside = others.filter(m =>
    m.y0 > minY && m.y0 < maxY && m.x0 > minX && m.x0 < maxX);
  ok(strayInside.length === 0,
     'no other feature\'s moves fall inside the extracted bounds - the object is the interface alone');
  console.log('  extracted: ' + group.moves.length + ' beads, ' + (pos.length / 9) +
              ' triangles, bounds X ' + minX.toFixed(2) + '..' + maxX.toFixed(2) +
              ' Y ' + minY.toFixed(2) + '..' + maxY.toFixed(2));
}

// ===========================================================================
section('6. Refusals');
// ===========================================================================
async function refusals() {
  const plain = path.join(REPO, 'fixtures', '3mf', 'pa_pattern.3mf');
  if (fs.existsSync(plain)) {
    let msg = '';
    try { await G.readSlicedGcode3MF(new Uint8Array(fs.readFileSync(plain))); }
    catch (e) { msg = e.message; }
    ok(/No sliced toolpath/.test(msg), 'an unsliced project is refused with a useful message');
    ok(/gcode\.3mf/.test(msg), 'the message says what kind of file to bring instead');
  }
  let junkMsg = '';
  try { await G.readSlicedGcode3MF(new Uint8Array([1, 2, 3, 4, 5])); }
  catch (e) { junkMsg = e.message; }
  ok(junkMsg.length > 0 && !/undefined/.test(junkMsg), 'junk bytes are reported, not thrown raw');
}

// ===========================================================================
section('7. Real Bambu Studio slice (NSO_GCODE_REAL)');
// ===========================================================================
async function realFile() {
  // Two real sliced files are now committed, so this tier runs by default
  // instead of skipping - it was the documented open item. NSO_GCODE_REAL still
  // overrides, to point the same measurements at any other slice.
  const COMMITTED = [
    path.join(REPO, 'fixtures', '3mf', 'tabletop.gcode.3mf'),
    path.join(REPO, 'fixtures', '3mf', 'supportwithinsupport.gcode.3mf')
  ].filter(f => fs.existsSync(f));
  const p = process.env.NSO_GCODE_REAL || COMMITTED.join(path.delimiter);
  if (!p) {
    console.log('  SKIPPED - no real slice found and NSO_GCODE_REAL is unset.');
    return;
  }
  for (const one of p.split(path.delimiter).filter(Boolean)) {
    const label = path.basename(one);
    if (!fs.existsSync(one)) { fail++; failures.push(label + ': not found'); console.log('  FAIL ' + label + ' not found'); continue; }
    const res = await G.readSlicedGcode3MF(new Uint8Array(fs.readFileSync(one)), { name: label });
    ok(res.parsed.moves.length > 0, label + ': extrusion moves found (' + res.parsed.moves.length + ')');
    ok(res.parsed.layers.length > 0, label + ': layers found (' + res.parsed.layers.length + ')');
    ok(res.parsed.features.length > 0, label + ': feature groups found (' + res.parsed.features.length + ')');
    ok(res.parsed.meta.filamentDiameterFromFile, label + ': filament diameter read from the file');
    ok(res.parsed.meta.assumed === false, label + ': nothing assumed - all numbers came from the file');
    // Fold, never spread: a real slice is hundreds of thousands of moves and
    // `Math.min(...arr)` blows the argument limit long before that.
    const span = (key) => res.parsed.moves.reduce(
      (a, m) => (m[key] < a[0] ? a[0] = m[key] : 0, m[key] > a[1] ? a[1] = m[key] : 0, a),
      [Infinity, -Infinity]);
    const [lo, hi] = span('width');
    ok(lo > 0.05 && hi < 3.0, label + ': widths are physically plausible (' +
       lo.toFixed(3) + ' .. ' + hi.toFixed(3) + ' mm)');
    const [hLo, hHi] = span('height');
    ok(hLo > 0.01 && hHi < 1.5, label + ': heights are plausible (' +
       hLo.toFixed(3) + ' .. ' + hHi.toFixed(3) + ' mm)');
    console.log('  ' + label + ': features = ' + res.parsed.features.map(f => f.name).join(', '));
    console.log('  ' + label + ': ' + res.parsed.layers.length + ' layers, ' +
                res.parsed.moves.length + ' moves, widths ' + lo.toFixed(3) + '-' + hi.toFixed(3) + ' mm');
  }
}

(async () => {
  await groundTruth();
  await solidity();
  await refusals();
  await realFile();
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  if (fail) { failures.forEach(f => console.log('  - ' + f)); process.exit(1); }
})().catch(e => { console.error(e); process.exit(1); });
