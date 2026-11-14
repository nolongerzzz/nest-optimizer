#!/usr/bin/env node
/*
 * The in-house slicer's own suite - Tasks 2-6, against independent answers.
 *
 *   node tools/nso_slicer_test.js
 *
 *   1. sections   every layer's area against manifold-3d's OWN slicer
 *                 (Manifold.slice - a different implementation, same kernel
 *                 build) on closed repo meshes; loop orientation; an open mesh;
 *                 a mesh wound inside out.
 *   2. walls      loop positions and counts on walls of known thickness.
 *   3. infill     grid line spacing and angle read back off the G-code;
 *                 density actually scales the extrusion.
 *   4. shells     top / bottom layer counts on a plain box.
 *   5. overhang   cones either side of the threshold; a mushroom's cap; a
 *                 floating slab over the plate vs over the piece.
 *   6. G-code     through parseGcode: widths recovered, nothing assumed.
 *   7. conflicts  two objects sharing a layer.
 *   8. constants  every measured default present, with its source.
 *   9. thin walls Detect thin wall (classic): a wall under 1.05 x the bead is
 *                 ONE centre pass at the bead's width - a strip, a ring, a
 *                 loop with a serpentine joined to it (one path, loop then
 *                 serpentine), a fin on a block; 1.05 x the bead and up
 *                 unchanged; on for a support, off for a part unless asked;
 *                 and the repo meshes' G-code pinned byte for byte, flag off
 *                 and on (none of them has a thin wall 0.13 mm or wider).
 */
'use strict';

const path = require('path');
const ROOT = path.join(__dirname, '..');
const SL = require('../nso_slicer.js');
const G = require('../nso-gcode-lines.js');
const { readSTL } = require('./nso_stl_io.js');
const crypto = require('crypto');

let pass = 0, fail = 0;
function check(what, cond, got) {
  if (cond) { pass++; console.log('  ok   ' + what + (got !== undefined ? '  [' + got + ']' : '')); }
  else { fail++; console.log('  FAIL ' + what + (got !== undefined ? '  [' + got + ']' : '')); }
}
function section(t) { console.log('\n== ' + t); }
const f4 = v => (+v).toFixed(4);

function quad(out, a, b, c, d) { out.push(...a, ...b, ...c, ...a, ...c, ...d); }
function prism(fp, z0, z1) {
  const out = [];
  const n = fp.length;
  for (let i = 1; i + 1 < n; i++) {
    out.push(fp[0][0], fp[0][1], z1, fp[i][0], fp[i][1], z1, fp[i + 1][0], fp[i + 1][1], z1);
    out.push(fp[0][0], fp[0][1], z0, fp[i + 1][0], fp[i + 1][1], z0, fp[i][0], fp[i][1], z0);
  }
  for (let i = 0; i < n; i++) {
    const p = fp[i], q = fp[(i + 1) % n];
    quad(out, [p[0], p[1], z0], [q[0], q[1], z0], [q[0], q[1], z1], [p[0], p[1], z1]);
  }
  return out;
}
const rect = (x0, x1, y0, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
const rect0 = rect;
/** Upright cone frustum, n sides, radius r0 at z0 -> r1 at z1 (outward wound). */
function frustum(n, r0, r1, z0, z1) {
  const out = [];
  const P = (r, k, z) => [r * Math.cos(2 * Math.PI * k / n), r * Math.sin(2 * Math.PI * k / n), z];
  for (let k = 0; k < n; k++) {
    const a0 = P(r0, k, z0), b0 = P(r0, k + 1, z0), a1 = P(r1, k, z1), b1 = P(r1, k + 1, z1);
    quad(out, a0, b0, b1, a1);
    out.push(0, 0, z1, ...a1, ...b1);
    out.push(0, 0, z0, ...b0, ...a0);
  }
  return out;
}
(async () => {
  const wasm = await SL.loadKernel({});

  // =========================================================================
  section('1. Sections - exact, against manifold-3d\'s own Manifold.slice');
  // =========================================================================
  const meshes = [
    ['fixtures/box-20mm.stl'], ['fixtures/cylinder_r10h30_s64.stl'], ['fixtures/fixture_sphere_curved.stl'],
    ['fixtures/hinge_knuckle_box.stl'], ['fixtures/quick/shape-torus.stl'], ['fixtures/quick/shape-tube.stl']
  ];
  for (const [f] of meshes) {
    const soup = readSTL(path.join(ROOT, f));
    const planes = SL.slicePlanes(zMinOf(soup), zMaxOf(soup), SL.defaultsFor(0.4));
    const mine = SL.sliceMesh(soup, planes, { weldMm: 1e-4 });
    // manifold's slicer on the same triangles
    const n = soup.length / 9;
    const mesh = new wasm.Mesh({ numProp: 3, vertProperties: Float32Array.from(soup), triVerts: Uint32Array.from({ length: n * 3 }, (_, i) => i) });
    mesh.merge();
    const man = new wasm.Manifold(mesh);
    let worst = 0, open = 0;
    mine.sections.forEach((sec, i) => {
      const a = sec.loops.reduce((s, l) => s + SL.signedArea(l), 0);
      const cs = man.slice(planes[i].sliceZ);
      const b = cs.area();
      cs.delete();
      open += sec.openChains;
      worst = Math.max(worst, Math.abs(a - b) / Math.max(1, b));
    });
    man.delete();
    check(f + ': every layer\'s area equals Manifold.slice\'s (rel 1e-5), no open chains', worst < 1e-5 && open === 0,
          planes.length + ' layers, worst rel ' + worst.toExponential(2));
  }
  {
    const soup = readSTL(path.join(ROOT, 'fixtures/quick/shape-tube.stl'));
    const pl = SL.slicePlanes(zMinOf(soup), zMaxOf(soup), SL.defaultsFor(0.4));
    const sec = SL.sliceMesh(soup, pl, {}).sections[Math.floor(pl.length / 2)];
    const areas = sec.loops.map(SL.signedArea).sort((a, b) => b - a);
    check('a tube: the outer loop runs counter-clockwise (+area), the bore clockwise (-area)',
          sec.loops.length === 2 && areas[0] > 0 && areas[1] < 0, areas.map(v => v.toFixed(2)).join(', '));
    const inv = soup.slice();
    for (let i = 0; i < inv.length; i += 9) for (let k = 0; k < 3; k++) { const t = inv[i + 3 + k]; inv[i + 3 + k] = inv[i + 6 + k]; inv[i + 6 + k] = t; }
    const r0 = SL.sliceObjects([{ name: 't', soup }], SL.defaultsFor(0.4, { emitGcode: false }), wasm);
    const r1 = SL.sliceObjects([{ name: 't', soup: inv }], SL.defaultsFor(0.4, { emitGcode: false }), wasm);
    const same = r0.objects[0].layers.every((L, i) => Math.abs(L.areaMm2 - r1.objects[0].layers[i].areaMm2) < 1e-6);
    check('wound inside out: detected, read reversed, the same section areas', r1.objects[0].flipped && !r0.objects[0].flipped && same);
  }
  {
    const soup = readSTL(path.join(ROOT, 'fixtures/damage/shape-sphere_hole.stl'));
    const r = SL.sliceObjects([{ name: 'open', soup }], SL.defaultsFor(0.4, { emitGcode: false }), wasm);
    const st = r.objects[0].sectionStats;
    check('an open mesh is still sliced: its open chains are counted and closed across the gap, none dropped',
          r.ok && st.openChains > 0 && st.closedByGap > 0 && st.droppedChains === 0, JSON.stringify(st));
  }
  {
    const r = SL.sliceObjects([{ name: 'box', soup: prism(rect(0, 20, 0, 20), 0, 10) }], SL.defaultsFor(0.4, { emitGcode: false }), wasm);
    const pz = r.planes.map(p => p.printZ);
    check('layer stack: print z 0.2, 0.4 ... 10.0 for a 10 mm part at 0.2 mm', pz.length === 50 && Math.abs(pz[0] - 0.2) < 1e-9 &&
          Math.abs(pz[49] - 10) < 1e-9, pz.length + ' layers, ' + f4(pz[0]) + '..' + f4(pz[49]));
    const r2 = SL.sliceObjects([{ name: 'box', soup: prism(rect(0, 20, 0, 20), 0, 10) }],
      SL.defaultsFor(0.4, { layerMm: 0.3, firstLayerMm: 0.2, emitGcode: false }), wasm);
    check('first layer height honoured (0.2 then 0.3)', Math.abs(r2.planes[0].h - 0.2) < 1e-9 && Math.abs(r2.planes[1].printZ - 0.5) < 1e-9);
  }

  // =========================================================================
  section('2. Walls - measured offsets, real loop counts');
  // =========================================================================
  {
    const o = SL.defaultsFor(0.4, { emitGcode: false });
    const w = o.outerWallWidthMm, s = SL.spacingOf(w, 0.2);
    check('default wall width is the repo\'s measured floor: 0.42 at 0.4, 0.63 at 0.6',
          w === 0.42 && SL.defaultsFor(0.6).outerWallWidthMm === 0.63);
    const r = SL.sliceObjects([{ name: 'box', soup: prism(rect(0, 20, 0, 20), 0, 4) }], o, wasm);
    const L = r.objects[0].layers[10];
    const outer = L.paths.find(p => p.feature === 'Outer wall'), inner = L.paths.find(p => p.feature === 'Inner wall');
    const minX = p => Math.min(...p.pts.map(q => q[0]));
    check('outer wall centre w/2 inside the part', Math.abs(minX(outer) - w / 2) < 1e-6, f4(minX(outer)));
    check('inner wall one stadium spacing inside that', Math.abs(minX(inner) - minX(outer) - s) < 1e-6, f4(minX(inner) - minX(outer)));
    const thin = (t) => SL.sliceObjects([{ name: 'rib', soup: prism(rect(0, 20, 0, t), 0, 4) }], o, wasm).objects[0].layers[10];
    const t1 = thin(1.0), t2 = thin(2.0), t3 = thin(0.3);
    check('a 1.0 mm rib takes ONE wall (too thin for a second at 0.42)', t1.wallCount === 1, t1.wallCount);
    check('a 2.0 mm rib takes two', t2.wallCount === 2, t2.wallCount);
    check('a 0.3 mm fin - thinner than one line - takes none', t3.wallCount === 0, t3.wallCount);
    const o5 = SL.defaultsFor(0.4, { wallLoops: 5, emitGcode: false });
    const b5 = SL.sliceObjects([{ name: 'box', soup: prism(rect(0, 20, 0, 20), 0, 4) }], o5, wasm).objects[0].layers[10];
    check('wallLoops is honoured: 5 loops, each one spacing further in', b5.wallCount === 5 &&
      b5.paths.filter(p => /wall/.test(p.feature)).map(minX).sort((a, b) => a - b)
        .every((x, i, arr) => i === 0 || Math.abs(x - arr[i - 1] - s) < 1e-6));
  }

  // =========================================================================
  section('3. Infill - real line families, density-parameterised');
  // =========================================================================
  {
    const soup = prism(rect(0, 40, 0, 40), 0, 6);
    const run = d => {
      const r = SL.sliceObjects([{ name: 'b', soup }], SL.defaultsFor(0.4, { sparseDensity: d }), wasm);
      return G.parseGcode(r.gcode).moves.filter(m => m.feature === 'Sparse infill' && Math.abs(m.z - 3.0) < 1e-6);
    };
    const m15 = run(0.15), m30 = run(0.30);
    const s = SL.spacingOf(0.42, 0.2);
    const diag = m15.filter(m => Math.abs(Math.sin(2 * m.angle)) > 0.999 && m.length > 2);
    const fam45 = diag.filter(m => Math.cos(2 * (m.angle - Math.PI / 4)) > 0);
    const us = [...new Set(fam45.map(m => Math.round((m.y0 - m.x0) / Math.SQRT2 * 1e3) / 1e3))].sort((a, b) => a - b);
    const gaps = us.slice(1).map((u, i) => u - us[i]);
    check('grid, 15 %: both 45 and 135 deg families on one layer', fam45.length > 0 && diag.length > fam45.length);
    check('grid line spacing is 2 x spacing / density', gaps.length > 2 && gaps.every(g => Math.abs(g - 2 * s / 0.15) < 1e-3),
          f4(gaps[0]) + ' vs ' + f4(2 * s / 0.15));
    const len = ms => ms.reduce((a, m) => a + m.length, 0);
    const ratio = len(m30) / len(m15);
    check('doubling density doubles the sparse extrusion (lines only; anchors differ) - within 15 %', Math.abs(ratio - 2) < 0.3, ratio.toFixed(3));
    const rz = SL.sliceObjects([{ name: 'b', soup }], SL.defaultsFor(0.4, { sparsePattern: 'zigzag' }), wasm);
    const zz = G.parseGcode(rz.gcode).moves.filter(m => m.feature === 'Sparse infill');
    const angs = z => new Set(zz.filter(m => Math.abs(m.z - z) < 1e-6 && m.length > 2 && Math.abs(Math.sin(2 * m.angle)) > 0.999)
      .map(m => Math.round(((m.angle * 180 / Math.PI) % 180 + 180) % 180)));
    const a1 = angs(3.0), a2 = angs(3.2);
    check('zigzag: one family per layer, alternating 45 / 135', a1.size === 1 && a2.size === 1 && [...a1][0] !== [...a2][0],
          [...a1] + ' / ' + [...a2]);
    const rs = zz.filter(m => Math.abs(m.z - 3.0) < 1e-6);
    check('zigzag lines are joined: fewer runs than lines', new Set(rs.map(m => m.run)).size < rs.filter(m => m.length > 2).length);
    // every infill point inside the part's infill boundary
    const r = SL.sliceObjects([{ name: 'b', soup }], SL.defaultsFor(0.4), wasm);
    const inset = 0.42 / 2 + s + s * 0.85;
    const moves = G.parseGcode(r.gcode).moves;
    const topZ = Math.max(...moves.map(m => m.z));
    const within = (ms, d) => ms.flatMap(m => [[m.x0, m.y0], [m.x1, m.y1]])
      .filter(([x, y]) => x < d - 1e-3 || y < d - 1e-3 || x > 40 - d + 1e-3 || y > 40 - d + 1e-3).length;
    const body = moves.filter(m => /infill|surface|Bridge/.test(m.feature) && m.z < topZ - 1e-6);
    check('every infill bead centre stays inside the infill boundary (0.85 spacing in from the inner wall)', within(body, inset) === 0,
          within(body, inset) + ' outside of ' + body.length * 2);
    // top layer: only the outer wall, so its fill runs out to 0.85 spacing inside THAT
    const top = moves.filter(m => m.feature === 'Top surface' && Math.abs(m.z - topZ) < 1e-6);
    const insetTop = 0.21 + 0.85 * s;
    check('on the top layer the fill reaches out to the outer wall instead, and no further', within(top, insetTop) === 0 &&
          Math.min(...top.flatMap(m => [m.x0, m.x1])) < inset - 0.1, within(top, insetTop) + ' outside');
  }

  // =========================================================================
  section('4. Shells');
  // =========================================================================
  {
    const r = SL.sliceObjects([{ name: 'b', soup: prism(rect(0, 30, 0, 30), 0, 6) }], SL.defaultsFor(0.4, { emitGcode: false }), wasm);
    const kinds = r.objects[0].layers.map(L => L.areas.sparse > 1 ? 'sparse' : 'solid');
    const firstSparse = kinds.indexOf('sparse'), lastSparse = kinds.lastIndexOf('sparse');
    // top: max(top_shell_layers 3, ceil(top_shell_thickness 0.8 / 0.2)) = 4
    check('3 bottom solid layers; 4 top (top_shell_thickness 0.8 mm at 0.2 mm layers); sparse between',
          firstSparse === 3 && lastSparse === kinds.length - 5,
          'sparse ' + firstSparse + '..' + lastSparse + ' of ' + kinds.length);
    const L0 = r.objects[0].layers[0], Lt = r.objects[0].layers[kinds.length - 1];
    check('the first layer is Bottom surface, the last Top surface',
          L0.paths.some(p => p.feature === 'Bottom surface') && Lt.paths.some(p => p.feature === 'Top surface'));
    check('the first solid layer over sparse is a (internal) Bridge, as in the real slice',
          r.objects[0].layers[lastSparse + 1].paths.some(p => p.feature === 'Bridge'));
    check('only the outer wall on the top layer (top_one_wall_type = all top)',
          Lt.wallCount === 1 && !Lt.paths.some(p => p.feature === 'Inner wall'));
  }

  // =========================================================================
  section('5. Overhang - per-layer geometry, independent of the facet detector');
  // =========================================================================
  {
    // Inverted cones: the flank's slope from horizontal is atan(h / (r1 - r0)).
    const cone = deg => frustum(64, 3, 3 + 8 / Math.tan(deg * Math.PI / 180), 0, 8);
    const call = (deg, thr) => SL.sliceObjects([{ name: 'c', soup: cone(deg) }],
      SL.defaultsFor(0.4, { supportThresholdDeg: thr, emitGcode: false }), wasm).objects[0].overhang;
    const o25 = call(25, 30), o35 = call(35, 30), o40 = call(40, 45), o50 = call(50, 45);
    check('a flank 25 deg off horizontal needs support at the 30 deg threshold', o25.length === 1 && o25[0].layers > 30,
          o25.length + ' region, ' + (o25[0] ? o25[0].layers : 0) + ' layers');
    check('a flank 35 deg off horizontal does not', o35.length === 0, o35.length);
    check('at 45 deg: 40 needs support, 50 does not', o40.length === 1 && o50.length === 0, o40.length + ' / ' + o50.length);
    check('the overhanging flank is one linked region through every layer, standing on the plate',
          o25[0].firstLayer === 1 && o25[0].standsOn === 'plate');
    // mushroom: a 4 mm stem under a 16 mm cap
    const mush = prism(rect(-2, 2, -2, 2), 0, 6).concat(prism(rect(-8, 8, -8, 8), 6, 8));
    const om = SL.sliceObjects([{ name: 'm', soup: mush }], SL.defaultsFor(0.4, { emitGcode: false }), wasm).objects[0];
    const step = 0.2 / Math.tan(30 * Math.PI / 180);
    const expect = 256 - (4 + 2 * step) * (4 + 2 * step);
    check('a mushroom cap: one region at its first layer, area = cap - (stem grown by the printable step)',
          om.overhang.length === 1 && Math.abs(om.overhang[0].footprintMm2 - expect) < 0.05,
          om.overhang.length + ' region, ' + (om.overhang[0] ? om.overhang[0].footprintMm2.toFixed(3) : '-') + ' vs ' + expect.toFixed(3));
    check('... and its outer wall on that layer is tagged Overhang wall',
          om.layers[om.overhang[0].firstLayer].paths.some(p => p.feature === 'Overhang wall'));
    // a slab floating over a block vs over the plate
    const over = prism(rect(0, 10, 0, 10), 0, 4).concat(prism(rect(0, 10, 0, 10), 5, 6));
    const oo = SL.sliceObjects([{ name: 'o', soup: over }], SL.defaultsFor(0.4, { emitGcode: false }), wasm).objects[0].overhang;
    // a ledge at an edge's END: a 13.5 mm slab on a 10 mm block, flush along two edges - their midpoints are over the block, their ends over air.
    // Bambu calls those ends Overhang wall (Circular and Sphere's corner ledges, 15.2); judged at the midpoint alone they are never found
    const ledge = prism(rect(0, 10, 0, 10), 0, 4).concat(prism(rect(-2, 11.5, 0, 10), 4, 4.4));
    const ledgeLen = sub => {
      const L = SL.sliceObjects([{ name: 'l', soup: ledge }], SL.defaultsFor(0.4, { emitGcode: false, wallLoops: 1, overhangSubMm: sub }), wasm).objects[0].layers;
      const first = L.find(l => l.printZ > 4.01);
      return first.paths.filter(q => q.feature === 'Overhang wall').reduce((a, q) => a + q.pts.reduce((b, pt, i) => i ? b + Math.hypot(pt[0] - q.pts[i - 1][0], pt[1] - q.pts[i - 1][1]) : 0, 0), 0);
    };
    const lenOld = ledgeLen(0), lenNew = ledgeLen(0.2);
    // the two short sides hang whole (2 x ~9.6 mm); the long sides' hanging ends are 2 x (1.8 + 1.3) mm more, found only along the edge
    check('a slab flush along two edges, 3.1 mm of each hanging past its block at the ends: the midpoint alone finds the two short sides only, the edge judged along its length finds the ends as well',
          Math.abs(lenOld - 19.2) < 1 && Math.abs((lenNew - lenOld) - 6.2) < 1,
          'midpoint ' + lenOld.toFixed(2) + ' mm; along the edge ' + lenNew.toFixed(2) + ' mm');
    check('the default is the along-the-edge rule (overhangSubMm 0.2)', SL.defaultsFor(0.4).overhangSubMm === 0.2, SL.defaultsFor(0.4).overhangSubMm);
    check('a slab over the piece itself needs support standing on the MODEL', oo.length === 1 && oo[0].standsOn === 'model', oo[0] && oo[0].standsOn);
    const half = prism(rect(0, 10, 0, 10), 0, 4).concat(prism(rect(0, 20, 0, 10), 5, 6));
    const oh = SL.sliceObjects([{ name: 'h', soup: half }], SL.defaultsFor(0.4, { emitGcode: false }), wasm).objects[0].overhang;
    check('half over the piece, half over the plate: "both", split by area',
          oh.length === 1 && oh[0].standsOn === 'both' && Math.abs(oh[0].overModelMm2 - 100) < 0.5 && Math.abs(oh[0].overPlateMm2 - 100) < 0.5,
          oh[0] && oh[0].overModelMm2.toFixed(2) + ' / ' + oh[0].overPlateMm2.toFixed(2));
  }

  // =========================================================================
  section('6. G-code - through the importer G-scope uses');
  // =========================================================================
  {
    const soup = readSTL(path.join(ROOT, 'fixtures/fixture_sphere_curved.stl'));
    const r = SL.sliceObjects([{ name: 'sphere', soup }], SL.defaultsFor(0.4), wasm);
    const p = G.parseGcode(r.gcode);
    check('parseGcode reads it with nothing assumed (filament, E mode, every layer height from the file)', !p.meta.assumed && !p.warnings.length);
    check('one parsed layer per sliced layer', p.meta.layerCount === r.planes.length, p.meta.layerCount + ' / ' + r.planes.length);
    const wErr = p.moves.reduce((m, mv) => Math.max(m, Math.abs(mv.width - 0.42)), 0);
    check('every move\'s width recovered from its own E: 0.42 (to 2e-3; XY are written to 4 decimals)', wErr < 2e-3, wErr.toExponential(2));
    const zs = new Set(p.moves.map(m => m.z.toFixed(4)));
    check('every move prints at a sliced layer\'s Z', [...zs].every(z => r.planes.some(pl => Math.abs(pl.printZ - +z) < 1e-6)));
    const feats = new Set(p.features.map(f => f.name));
    const known = Object.keys(G.FEATURE_COLORS);
    check('every feature name is one G-scope already colours', [...feats].every(f => known.includes(f)), [...feats].join(', '));
    const loops = p.moves.filter(m => m.feature === 'Outer wall');
    const runs = new Set(loops.map(m => m.run));
    const nPaths = r.objects[0].layers.reduce((a, L) => a + L.paths.filter(q => q.feature === 'Outer wall').length, 0);
    check('each wall path prints as one continuous run: travel between paths, none within', runs.size === nPaths && nPaths < loops.length,
          runs.size + ' runs, ' + nPaths + ' paths, ' + loops.length + ' moves');
  }

  // =========================================================================
  section('7. Conflicts - two objects on one layer');
  // =========================================================================
  {
    const a = prism(rect(0, 10, 0, 10), 0, 5), b = prism(rect(9, 19, 0, 10), 2, 5), c = prism(rect(10.5, 19, 0, 10), 0, 5);
    const r = SL.sliceObjects([{ name: 'a', soup: a }, { name: 'b', soup: b }], SL.defaultsFor(0.4, { emitGcode: false }), wasm);
    const layers = r.conflicts.map(k => k.layer);
    check('overlapping objects: a conflict on every shared layer, numbered from 1, 10 mm^2 each',
          layers.length === 15 && layers[0] === 11 && r.conflicts.every(k => Math.abs(k.areaMm2 - 10) < 1e-6),
          layers[0] + '..' + layers[layers.length - 1] + ', ' + (r.conflicts[0] ? r.conflicts[0].areaMm2.toFixed(3) : '-'));
    const r2 = SL.sliceObjects([{ name: 'a', soup: a }, { name: 'c', soup: c }], SL.defaultsFor(0.4, { emitGcode: false }), wasm);
    check('0.5 mm apart: no conflict', r2.conflicts.length === 0, r2.conflicts.length);
  }

  // =========================================================================
  section('8. Constants and the kernel');
  // =========================================================================
  {
    const C = SL.CONSTANTS;
    const keys = ['wallWidth', 'bambuLine06', 'perimeterRule', 'supportThresholdDeg', 'treeTaper', 'treeWall', 'supportGap', 'interfaceStrand', 'flow'];
    check('every measured constant is present and cites its source', keys.every(k => C[k] && typeof C[k].source === 'string' && C[k].source.length > 40));
    check('the taper law is the tree module\'s own (2 mm tip, 5 deg)', C.treeTaper.tipDiameterMm === 2 && C.treeTaper.angleDeg === 5);
    check('the gap: 0.18 designed, 0.182 measured', C.supportGap.designMm === 0.18 && C.supportGap.measuredMm === 0.182);
    check('the interface: NSO 0.42 @ 1.2, Bambu 0.61 @ 1.09', C.interfaceStrand.nso.widthMm === 0.42 && C.interfaceStrand.nso.pitchMm === 1.2 &&
          C.interfaceStrand.bambuMeasured.widthMm === 0.61 && C.interfaceStrand.bambuMeasured.pitchMm === 1.09);
    const g = SL.geometry(wasm);
    const a = g.of([rect(0, 10, 0, 10)]); g.offset(a, -1); g.inter(a, g.of([rect(5, 15, 0, 10)]));
    const before = g.arenaSize(); g.free();
    check('the Clipper2 adapter frees every WASM object it made', before > 0 && g.arenaSize() === 0, before + ' freed');
    check('an empty polygon list is an empty section, not a crash (binding: polygons2vec reads polygons[0])',
          (() => { const h = SL.geometry(wasm); try { return h.of([]).isEmpty(); } finally { h.free(); } })());
  }

  // =========================================================================
  section('9. Thin walls - classic walls with Detect thin wall on');
  // =========================================================================
  {
    const W = SL.defaultsFor(0.4).outerWallWidthMm;            // 0.42
    /* a region (polygons with holes, Positive) extruded z0..z1, as a soup */
    const extrudeCS = (polys, z0, z1) => {
      const cs = new wasm.CrossSection(polys, 'Positive');
      const m = cs.extrude(z1 - z0), mesh = m.getMesh(), np = mesh.numProp, V = mesh.vertProperties, T = mesh.triVerts, out = [];
      for (let i = 0; i < T.length; i++) out.push(V[T[i] * np], V[T[i] * np + 1], V[T[i] * np + 2] + z0);
      cs.delete(); m.delete();
      return out;
    };
    const unionRects = rs => {
      const parts = rs.map(r => new wasm.CrossSection([rect(...r)], 'Positive'));
      const u = wasm.CrossSection.union(parts), polys = u.toPolygons();
      parts.forEach(c => c.delete()); u.delete();
      return polys;
    };
    const plen = p => { const q = p.closed ? p.pts.concat([p.pts[0]]) : p.pts; let l = 0; for (let i = 0; i + 1 < q.length; i++) l += Math.hypot(q[i + 1][0] - q[i][0], q[i + 1][1] - q[i][1]); return l; };
    const opts = over => SL.defaultsFor(0.4, Object.assign({ layerMm: 0.2, firstLayerMm: 0.2 }, over));
    const slice = (soup, over, ob) => SL.sliceObjects([Object.assign({ name: 't', soup }, ob || {})], opts(over), wasm);
    const live = r => r.objects[0].layers.filter(L => L.areaMm2 > 0);

    // a 0.40 x 20 strip, 1 mm tall: nothing without the flag, one pass with it
    const strip = (wd, len) => prism(rect(0, len, 0, wd), 0, 1);
    const off40 = slice(strip(0.40, 20)), on40 = slice(strip(0.40, 20), { detectThinWall: true });
    check('a 0.40 strip (under the bead): without Detect thin wall, nothing is drawn (the classic inset keeps nothing)',
          live(off40).every(L => L.paths.length === 0), live(off40).map(L => L.paths.length).join(' '));
    const ps = live(on40).map(L => L.paths);
    const p0 = ps[0][0];
    check('...with it, every layer is ONE open Outer wall pass at the bead\'s width, down the middle (y 0.200), its ends flush: half a bead in (x 0.200 - 19.800)',
          ps.length === 5 && ps.every(l => l.length === 1 && !l[0].closed && l[0].feature === 'Outer wall' && l[0].width === W && l[0].thinWall) &&
          ps.every(l => l[0].pts.every(q => Math.abs(q[1] - 0.2) < 0.022)) &&
          ps.every(l => { const xs = l[0].pts.map(q => q[0]); return Math.abs(Math.min(...xs) - 0.2) < 0.022 && Math.abs(Math.max(...xs) - 19.8) < 0.022; }),
          ps.length + ' layers; ' + p0.pts.map(q => q.map(f4).join(',')).join(' -> '));
    const pg = G.parseGcode(on40.gcode);
    const thinMoves = pg.moves.filter(m => m.feature === 'Outer wall');
    check('...and its G-code reads back at the bead\'s own width (flow for a full bead, as Bambu\'s thin wall: E/mm = its outer wall\'s)',
          thinMoves.length > 0 && thinMoves.every(m => Math.abs(m.width - W) < 2e-4), thinMoves.length + ' moves at ' + f4(thinMoves[0] && thinMoves[0].width));
    // 0.43: a sliver drawn round, out and back, without; one pass with
    const off43 = slice(strip(0.43, 20)), on43 = slice(strip(0.43, 20), { detectThinWall: true });
    const len43 = live(off43).map(L => L.paths.reduce((a, q) => a + plen(q), 0));
    check('a 0.43 strip: without the flag a closed sliver outline (two passes, out and back); with it ONE open pass, the same path count as 0.40',
          live(off43).every(L => L.paths.length === 1 && L.paths[0].closed) && len43.every(l => l > 39) &&
          live(on43).every((L, i) => L.paths.length === 1 && !L.paths[0].closed && Math.abs(plen(L.paths[0]) - plen(ps[i][0])) < 0.05),
          'without: ' + len43.map(l => l.toFixed(2)).join(' ') + ' mm; with: ' + live(on43).map(L => plen(L.paths[0]).toFixed(2)).join(' ') + ' mm');
    // 1.05 x the bead and up: walls as ever, byte for byte
    const thick = [0.45, 0.63, 1.0, 2.0].map(wd => { const a = slice(strip(wd, 20)).gcode, b = slice(strip(wd, 20), { detectThinWall: true }).gcode; return a === b; });
    check('strips of 0.45 / 0.63 / 1.0 / 2.0 mm (1.05 bead = ' + f4(1.05 * W) + ' and up): the same G-code with the flag as without', thick.every(Boolean), thick.join(' '));
    // a ring: one closed path round its middle
    const ring = (() => { const n = 96, P = r => Array.from({ length: n }, (_, k) => [r * Math.cos(2 * Math.PI * k / n), r * Math.sin(2 * Math.PI * k / n)]);
      return extrudeCS([P(5.2), P(4.8).reverse()], 0, 1); })();
    const rr = live(slice(ring, { detectThinWall: true }));
    const want = 2 * Math.PI * 5 * Math.cos(Math.PI / 96);   // the 96-gon's own centreline
    check('a 0.40 ring (r 5): ONE closed path a layer round its middle, its length the centreline\'s to 0.5 %',
          rr.every(L => L.paths.length === 1 && L.paths[0].closed && Math.abs(plen(L.paths[0]) / want - 1) < 0.005 &&
            L.paths[0].pts.every(q => Math.abs(Math.hypot(q[0], q[1]) - 5) < 0.03)),
          rr.map(L => L.paths.length + ' ' + (L.paths[0] && L.paths[0].closed ? 'closed ' : 'open ') + (L.paths[0] ? plen(L.paths[0]).toFixed(2) : '-')).join(' | ') + ' against ' + want.toFixed(2));
    // a loop with a serpentine joined to it at one point (the support sheet's shape)
    const PITCH = 0.84;
    const centre = [[[0.2, 0.2], [9.8, 0.2]], [[9.8, 0.2], [9.8, 5.8]], [[9.8, 5.8], [0.2, 5.8]], [[0.2, 5.8], [0.2, 0.2]],   // the loop, 9.6 x 5.6
                    [[9.8, 1.04], [8.96, 1.04]]];                                                                          // the bridge, one pitch
    let x = 8.96, up = true, nLines = 0;
    while (x >= 1.04 - 1e-9) {                                                     // lines a pitch apart, a pitch off the loop
      centre.push(up ? [[x, 1.04], [x, 4.96]] : [[x, 4.96], [x, 1.04]]); nLines++;
      if (x - PITCH >= 1.04 - 1e-9) centre.push([[x, up ? 4.96 : 1.04], [x - PITCH, up ? 4.96 : 1.04]]);
      x -= PITCH; up = !up;
    }
    /* each centreline segment a strip 0.40 wide, square ends half a line past its points (as the sheet is built) */
    const rects = centre.map(([a, b]) => [Math.min(a[0], b[0]) - 0.2, Math.max(a[0], b[0]) + 0.2, Math.min(a[1], b[1]) - 0.2, Math.max(a[1], b[1]) + 0.2]);
    const sheet = extrudeCS(unionRects(rects), 0, 0.6);
    const sr = live(slice(sheet, { detectThinWall: true }));
    const planLen = centre.reduce((a, [p, q]) => a + Math.hypot(q[0] - p[0], q[1] - p[1]), 0);
    check('a loop and a serpentine joined to it at one point (' + nLines + ' lines): ONE path a layer - the loop, then the serpentine, no travel between - its length the plan\'s to 1 %',
          sr.length === 3 && sr.every(L => L.paths.length === 1 && !L.paths[0].closed && Math.abs(plen(L.paths[0]) / planLen - 1) < 0.01),
          sr.map(L => L.paths.length + ' path(s), ' + L.paths.map(q => plen(q).toFixed(2) + ' mm in ' + (q.pts.length - 1) + ' moves').join(', ')).join(' | ') + ' against ' + planLen.toFixed(2));
    const first = sr[0].paths[0].pts, onLoop = q => Math.min(Math.abs(q[0] - 0.2), Math.abs(q[0] - 9.8), Math.abs(q[1] - 0.2), Math.abs(q[1] - 5.8)) < 0.03;
    let k = 0; while (k < first.length && onLoop(first[k])) k++;
    check('...it starts on the loop, goes all the way round it, then leaves it once for the serpentine',
          onLoop(first[0]) && k >= 5 && first.slice(k).every(q => !onLoop(q)), k + ' loop points, then ' + (first.length - k));
    // a thin fin on a block: the block keeps its walls, the fin is one pass into the block's outer wall
    const fin = extrudeCS(unionRects([[0, 10, 0, 10], [10, 15, 4.8, 5.2]]), 0, 0.6);
    const block = extrudeCS(unionRects([[0, 10, 0, 10]]), 0, 0.6);
    const fr = live(slice(fin, { detectThinWall: true })), br = live(slice(block));
    const finPaths = fr.map(L => L.paths.filter(q => q.thinWall));
    const outerSame = fr.every((L, i) => JSON.stringify(L.paths.filter(q => !q.thinWall && /wall/.test(q.feature)).map(q => q.pts)) ===
                                         JSON.stringify(br[i].paths.filter(q => /wall/.test(q.feature)).map(q => q.pts)));
    check('a 0.40 fin on a block: the block\'s walls are the block\'s own; the fin ONE pass that runs on into the block to its outer wall (x 9.79)',
          outerSame && finPaths.every(l => l.length === 1 && Math.abs(Math.min(...l[0].pts.map(q => q[0])) - (10 - W / 2)) < 0.03 &&
            Math.abs(Math.max(...l[0].pts.map(q => q[0])) - 14.8) < 0.03),
          'block walls the same: ' + outerSame + '; fin x ' + finPaths.map(l => l[0] ? Math.min(...l[0].pts.map(q => q[0])).toFixed(3) + ' - ' + Math.max(...l[0].pts.map(q => q[0])).toFixed(3) : '-').join(' | '));
    // who has it on
    const asSupport = live(slice(strip(0.40, 20), {}, { role: 'support' })), asPart = live(slice(strip(0.40, 20), {}, { role: 'part' }));
    const forced = live(slice(strip(0.40, 20), { detectThinWall: true }, { detectThinWall: false }));
    check('on for a support (every NSO support carries detect_thin_wall = 1), off for a part, and an object can say either way',
          SL.CONSTANTS.thinWall.supportsOn === true && SL.defaultsFor(0.4).detectThinWall === false &&
          asSupport.every(L => L.paths.length === 1) && asPart.every(L => L.paths.length === 0) && forced.every(L => L.paths.length === 0));
    check('the thin-wall constants cite their source: 1.05 x the bead, 0.13 mm the thinnest wall printed',
          SL.CONSTANTS.thinWall.ratio === 1.05 && SL.CONSTANTS.thinWall.minMm === 0.13 && SL.CONSTANTS.thinWall.source.length > 40);
    // the repo meshes, pinned: G-code sha256 (first 16 hex) at both nozzles, flag off and on - the slicer's own defaults.
    // hinge_knuckle_box and the two top_clip_x2 meshes were re-pinned when an overhang wall began to be judged along each edge (overhangSubMm 0.2), not at its midpoint alone: their overhang runs are cut where the layer below ends, not at the next vertex;
    // fixture_sphere_curved, hinge_knuckle_box and shape-torus again when a wall became Overhang wall only where its whole width hangs (overhangEdgeFrac 1, Bambu's: the dome heads' overhang length 170 -> 44 mm against its 44)
    const PINS = {
      'fixtures/box-20mm.stl': ['bf4fa6385480d9a1', '1ce8c7eb4eca30e8'],
      'fixtures/cylinder_r10h30_s64.stl': ['4102db1663681585', 'ee3474b981bba976'],
      'fixtures/fixture_sphere_curved.stl': ['b20238310238d62d', '765e9c3a4bbce169'],
      'fixtures/hinge_knuckle_box.stl': ['65695c31c351d63d', '3f137c8232bffa7e'],
      'fixtures/quick/shape-torus.stl': ['95b2b40eb073d5c0', 'e686396781f0952d'],
      'fixtures/quick/shape-tube.stl': ['59dafe6c8652a59d', 'df62d80fe91a6680'],
      'fixtures/supports/top_clip_x2.stl': ['5fc226e22b9cc74a', '4e4837b6bd636b56'],
      'fixtures/supports/top_clip_x2_coupon.stl': ['a307947b2d6f8c8f', 'eabd2bd7a782ca2c']
    };
    const bad = [];
    let n = 0;
    for (const f of Object.keys(PINS)) {
      const soup = readSTL(path.join(ROOT, f));
      [0.4, 0.6].forEach((nz, i) => [false, true].forEach(on => {
        const r = SL.sliceObjects([{ name: path.basename(f), soup }], SL.defaultsFor(nz, { detectThinWall: on }), wasm);
        const hsh = crypto.createHash('sha256').update(r.gcode).digest('hex').slice(0, 16);
        n++;
        if (hsh !== PINS[f][i]) bad.push(f + ' @' + nz + (on ? ' on' : ' off') + ': ' + hsh);
      }));
    }
    check('the repo meshes slice byte for byte as before the thin-wall pass, with it off and on (' + n + ' slices pinned)', !bad.length, bad.join('; ') || 'all ' + n);
  }

  section('The raft: its own system under the plate, as Bambu lays it (fixtures/supports/raft_circle.gcode.3mf, docs/SLICER.md "The raft")');
  {
    const disc = [];
    for (let i = 0, n = 128; i < n; i++) {
      const a = 2 * Math.PI * i / n, b = 2 * Math.PI * (i + 1) / n, A = [25 * Math.cos(a), 25 * Math.sin(a)], B = [25 * Math.cos(b), 25 * Math.sin(b)];
      disc.push(0, 0, 0, B[0], B[1], 0, A[0], A[1], 0, 0, 0, 2.08, A[0], A[1], 2.08, B[0], B[1], 2.08, A[0], A[1], 0, B[0], B[1], 0, B[0], B[1], 2.08, A[0], A[1], 0, B[0], B[1], 2.08, A[0], A[1], 2.08);
    }
    const sl = (N) => SL.sliceObjects([{ name: 'disc', soup: disc, key: 1, role: 'part' }], SL.defaultsFor(0.4, { layerMm: 0.16, firstLayerMm: 0.2, supportWidthMm: 0.42, raftLayers: N, raftContactMm: 0.1 }), wasm);
    const r8 = sl(8), raft = r8.objects.find(ob => ob.role === 'raft'), part = r8.objects.find(ob => ob.role === 'part');
    const zs = raft.layers.map(L => L.printZ.toFixed(2)).join(' '), kinds = raft.layers.map(L => L.paths[0].feature === 'Support' ? 'B' : 'I').join('');
    check('8 layers: 4 base (Support) then 4 interface (Support interface) at z 0.2, 0.5 ... 2.3 - Bambu\'s', zs === '0.20 0.50 0.80 1.10 1.40 1.70 2.00 2.30' && kinds === 'BBBBIIII', zs + ' ' + kinds);
    check('the part\'s first layer is an ordinary 0.16 on the raft\'s top + 0.1: z 2.56 (Bambu\'s)', Math.abs(part.layers[0].printZ - 2.56) < 1e-6 && Math.abs(part.layers[0].h - 0.16) < 1e-6, part.layers[0].printZ + ' / ' + part.layers[0].h);
    const ys = [];
    raft.layers[1].paths.forEach(p => { for (let i = 0; i + 1 < p.pts.length; i++) { const a = p.pts[i], b = p.pts[i + 1]; if (Math.abs(b[1] - a[1]) < 1e-6 && Math.abs(b[0] - a[0]) > 1) ys.push(+a[1].toFixed(3)); } });
    const u = [...new Set(ys)].sort((a, b) => a - b), gap = u.length > 1 ? u[1] - u[0] : 0;
    check('the base lines run along X 2.856 apart (support_base_pattern_spacing 2.5; Bambu\'s 2.856)', Math.abs(gap - 2.856) < 0.01, gap.toFixed(3));
    const reach = (L) => { let m = 0; L.paths.forEach(p => p.pts.forEach(q => { m = Math.max(m, Math.hypot(q[0], q[1])); })); return m + 0.21 - 25; };
    check('it reaches 1.5 past the disc on its top layer, 2.0 under it (the circle\'s 1.5 / 2.0)', Math.abs(reach(raft.layers[7]) - 1.5) < 0.1 && Math.abs(reach(raft.layers[3]) - 2.0) < 0.1, reach(raft.layers[7]).toFixed(2) + ' / ' + reach(raft.layers[3]).toFixed(2));
    const k = (N) => { const r = sl(N), ra = r.objects.find(ob => ob.role === 'raft'); return ra.layers.map(L => L.paths[0].feature === 'Support' ? 'B' : 'I').join(''); };
    const splits = [1, 2, 3, 4].map(k).join(' ');
    check('the split: 1 -> I, 2 -> BI, 3 -> BII, 4 -> BBII (the owner\'s 1 - 4 layer slices)', splits === 'I BI BII BBII', splits);
    check('no raft (0): no raft object, the part on the plate as before', !sl(0).objects.some(ob => ob.role === 'raft') && Math.abs(sl(0).objects[0].layers[0].printZ - 0.2) < 1e-6);
    check('the G-code carries it as Bambu writes it: Support and Support interface before the part\'s walls', /FEATURE: Support\n[\s\S]*FEATURE: Support interface[\s\S]*FEATURE: Outer wall/.test(SL.toGcode(r8)));
  }

  section('Concentric - rings along the outline, against a real Bambu slice (fixtures/slicer-concentric-reference.json, docs/SLICER.md "Concentric")');
  {
    const REF = JSON.parse(require('fs').readFileSync(path.join(ROOT, 'fixtures', 'slicer-concentric-reference.json'), 'utf8'));
    const plen = p => { let l = 0; const q = p.closed ? p.pts.concat([p.pts[0]]) : p.pts; for (let i = 1; i < q.length; i++) l += Math.hypot(q[i][0] - q[i - 1][0], q[i][1] - q[i - 1][1]); return l; };
    const box = pts => [Math.min(...pts.map(q => q[0])), Math.min(...pts.map(q => q[1])), Math.max(...pts.map(q => q[0])), Math.max(...pts.map(q => q[1]))];
    const opt = (over) => SL.defaultsFor(0.4, Object.assign({ layerMm: 0.2, outerWallWidthMm: 0.42, innerWallWidthMm: 0.45, infillWidthMm: 0.42, topShellLayers: 5, bottomShellLayers: 3 }, over));
    const res = SL.sliceObjects(REF.shapes.map(sh => ({ name: sh.name, soup: prism(sh.outline, 0, sh.layers * 0.2) })), opt({ solidPattern: 'concentric' }), wasm);
    const fills = (ob, li) => ob.layers[li].paths.filter(p => !/wall/i.test(p.feature));
    /* the reference's pentagon ends its solid layers in a dot 0.645 wide where this lays a last ring 0.344 wide: the same room, shared by two */
    const KNOWN = { 'pentagon solid': true };
    let worstBox = 0, worstW = 0, counts = [], kinds = 0, n = 0;
    REF.shapes.forEach((sh, k) => {
      [['solid', 1], ['top', sh.layers - 1]].forEach(([what, li]) => {
        const want = sh[what], mine = fills(res.objects[k], li);
        const rings = mine.filter(p => p.closed).sort((a, b) => plen(b) - plen(a)), inner = mine.slice().sort((a, b) => plen(a) - plen(b))[0];
        const b = box(rings[0].pts);
        b.forEach((v, i) => { worstBox = Math.max(worstBox, Math.abs(v - want.outerRing[i])); });
        if (mine.every(p => p.feature === want.feature)) kinds++;
        n++;
        if (KNOWN[sh.name + ' ' + what]) return;
        counts.push(mine.length - want.paths);
        worstW = Math.max(worstW, Math.abs(inner.width - want.innerWidth));
      });
    });
    check('seven shapes, a solid layer and the top each: the outermost ring where Bambu\'s is (within 0.003 mm)', worstBox < 0.003, worstBox.toFixed(4));
    check('...as many paths as Bambu lays (every ring, and the middle)', counts.every(c => c === 0), counts.join(' '));
    check('...the innermost one as wide as Bambu\'s (within 0.002 mm): the middle shares out what the spacing does not divide', worstW < 0.002, worstW.toFixed(4));
    check('...typed as Bambu types them (Internal solid infill; Top surface on top)', kinds === n, kinds + '/' + n);
    const rect = res.objects[REF.shapes.findIndex(sh => sh.name === 'rectangle')], rr = fills(rect, 1);
    const xs = rr.map(p => box(p.pts)[2]), steps = xs.slice(2).map((x, i) => x - xs[i + 1]);
    check('the rings print from the middle outward, one bead spacing apart (0.3771)', steps.every(d => Math.abs(d - SL.spacingOf(0.42, 0.2)) < 1e-3), f4(steps[0]));
    check('each ring starts beside the last one\'s start: the seams in a row', rr.slice(1).every((p, i) => Math.hypot(p.pts[0][0] - rr[i].pts[0][0], p.pts[0][1] - rr[i].pts[0][1]) < 0.45));
    const first = fills(rect, 0);
    check('the first layer is the Bottom surface, in rings', first.length > 10 && first.every(p => p.feature === 'Bottom surface' && p.closed));
    /* what is laid is what the region holds: bead area x length against the layer's solid area x height */
    /* the room: the outline in by the outer wall's half width, the two walls' mean spacing and the ring's 0.333, back out by half a bead */
    const gq = SL.geometry(wasm), sB = SL.spacingOf(0.42, 0.2);
    const roomOf = (outline) => gq.area(gq.offset(gq.of([outline]), -(0.21 + (sB + SL.spacingOf(0.45, 0.2)) / 2 + 0.85 * (sB + SL.spacingOf(0.45, 0.2)) / 2 - sB / 2))) * 0.2;
    const vol = rr.reduce((a, p) => a + plen(p) * SL.beadArea(p.width, 0.2), 0), room = roomOf(REF.shapes.find(sh => sh.name === 'rectangle').outline);
    check('the rings fill the layer: their volume within 1.5 % of the room inside the walls', Math.abs(vol / room - 1) < 0.015, (vol / room).toFixed(3));
    const moves = G.parseGcode(SL.toGcode(res)).moves.filter(m => m.feature === 'Internal solid infill');
    check('through the importer: the solid infill\'s widths read back, the middle rings\' own among them', moves.some(m => Math.abs(m.width - 0.42) < 2e-3) && moves.some(m => Math.abs(m.width - 0.483) < 3e-3));
    /* a part with a notch (an L): the rings split round the corner and each arm ends in its own middle */
    const L = [[0, 0], [30, 0], [30, 10], [10, 10], [10, 25], [0, 25]];
    const tri = []; [[0, 1, 2], [0, 2, 3], [0, 3, 5], [3, 4, 5]].forEach(t => { tri.push(t); });
    const lsoup = []; tri.forEach(t => { const [a, b, c] = t.map(i => L[i]); lsoup.push(a[0], a[1], 1, b[0], b[1], 1, c[0], c[1], 1, a[0], a[1], 0, c[0], c[1], 0, b[0], b[1], 0); });
    L.forEach((p0, i) => { const q = L[(i + 1) % L.length]; quad(lsoup, [p0[0], p0[1], 0], [q[0], q[1], 0], [q[0], q[1], 1], [p0[0], p0[1], 1]); });
    const rl = SL.sliceObjects([{ name: 'L', soup: lsoup }], opt({ solidPattern: 'concentric' }), wasm), lf = fills(rl.objects[0], 1);
    const lvol = lf.reduce((a, p) => a + plen(p) * SL.beadArea(p.width, 0.2), 0), lroom = roomOf(L);
    check('an L: filled the same (volume within 2.5 %), every line inside the walls', Math.abs(lvol / lroom - 1) < 0.025 && lf.every(p => p.pts.every(q => SL.inside([L], q[0], q[1]))), (lvol / lroom).toFixed(3));
    /* sparse: the first ring along the walls, the rest a spacing over the density apart */
    const box20 = prism(rect0(0, 40, 0, 40), 0, 6);
    const rs = SL.sliceObjects([{ name: 'b', soup: box20 }], opt({ sparsePattern: 'concentric', topShellLayers: 3, sparseDensity: 0.25 }), wasm);
    const sp = rs.objects[0].layers[15].paths.filter(p => p.feature === 'Sparse infill'), sx = sp.map(p => box(p.pts)[2]).sort((a, b) => b - a);
    const gaps = sx.slice(1).map((x, i) => sx[i] - x);
    check('sparse concentric: closed rings, spacing / density apart (0.3771 / 0.25 = 1.508)', sp.length > 5 && sp.every(p => p.closed && p.width === 0.42) && gaps.every(d => Math.abs(d - SL.spacingOf(0.42, 0.2) / 0.25) < 1e-3), sp.length + ' rings, ' + f4(gaps[0]));
    gq.free();
    check('...and the shells above it stay lines (solidPattern untouched)', rs.objects[0].layers[29].paths.filter(p => p.feature === 'Top surface').every(p => !p.closed));
    const tb = SL.sliceObjects([{ name: 'b', soup: box20 }], opt({ topPattern: 'concentric', topShellLayers: 3 }), wasm).objects[0];
    check('topPattern alone: the top in rings, the solid infill under it and the first layer in lines',
          tb.layers[29].paths.filter(p => p.feature === 'Top surface').every(p => p.closed) && tb.layers[28].paths.filter(p => p.feature === 'Internal solid infill').every(p => !p.closed) &&
          tb.layers[0].paths.filter(p => p.feature === 'Bottom surface').every(p => !p.closed));
  }

  section('Rectilinear - Bambu\'s name for the zigzag lines, against a real Bambu slice (fixtures/slicer-rectilinear-reference.json, docs/SLICER.md "Rectilinear")');
  {
    const fsx = require('fs');
    const OUT = JSON.parse(fsx.readFileSync(path.join(ROOT, 'fixtures', 'slicer-concentric-reference.json'), 'utf8')).shapes;
    const REF = JSON.parse(fsx.readFileSync(path.join(ROOT, 'fixtures', 'slicer-rectilinear-reference.json'), 'utf8')).shapes;
    const opt = (over) => SL.defaultsFor(0.4, Object.assign({ layerMm: 0.2, outerWallWidthMm: 0.42, innerWallWidthMm: 0.45, infillWidthMm: 0.42, topShellLayers: 5, bottomShellLayers: 3 }, over));
    const objs = OUT.map(sh => ({ name: sh.name, soup: prism(sh.outline, 0, sh.layers * 0.2) }));
    const o = opt({ solidPattern: 'rectilinear', sparsePattern: 'rectilinear' });
    check('the name is taken: rectilinear (and the profile\'s zig-zag) is the slicer\'s zigzag', o.solidPattern === 'zigzag' && o.sparsePattern === 'zigzag' && opt({ sparsePattern: 'zig-zag' }).sparsePattern === 'zigzag' &&
      SL.patternLabel('zigzag') === 'rectilinear' && SL.patternLabel('grid') === 'grid');
    const res = SL.sliceObjects(objs, o, wasm);
    const stat = (paths) => {
      let tot = 0; const c = {}; let lines = 0;
      paths.forEach(p => { for (let i = 1; i < p.pts.length; i++) { const a = p.pts[i - 1], b = p.pts[i], l = Math.hypot(b[0] - a[0], b[1] - a[1]); tot += l;
        if (l > 1.5) { lines++; const g2 = ((Math.round(Math.atan2(b[1] - a[1], b[0] - a[0]) * 180 / Math.PI) % 180) + 180) % 180; c[g2] = (c[g2] || 0) + 1; } } });
      return { angle: +Object.keys(c).sort((a, b) => c[b] - c[a])[0], lines: lines, length: tot };
    };
    let angles = 0, n = 0, worstLines = 0, worstLen = 0, kinds = 0;
    REF.forEach((sh, k) => {
      [['solid', 1], ['solid2', 2], ['top', OUT[k].layers - 1]].forEach(([what, li]) => {
        const want = sh[what], mine = res.objects[k].layers[li].paths.filter(p => !/wall/i.test(p.feature)), st = stat(mine);
        n++;
        if (st.angle === want.angle) angles++;
        if (mine.every(p => p.feature === want.feature && !p.closed)) kinds++;
        worstLines = Math.max(worstLines, Math.abs(st.lines - want.lines));
        worstLen = Math.max(worstLen, Math.abs(st.length / want.length - 1));
      });
    });
    check('seven shapes, two solid layers and the top each: the lines at Bambu\'s angle, 45 and 135 turn about', angles === n, angles + '/' + n);
    check('...as many lines as Bambu lays, within 2 (it widens the line 0.420 - 0.428 to fit a whole number across)', worstLines <= 2, 'worst ' + worstLines);
    check('...the length laid within 3.5 % of Bambu\'s', worstLen < 0.035, (worstLen * 100).toFixed(1) + ' %');
    check('...typed as Bambu types them, in open lines', kinds === n, kinds + '/' + n);
  }

  section('Archimedean chords - one spiral, against a real Bambu slice (fixtures/slicer-archimedean-reference.json, docs/SLICER.md "Archimedean chords")');
  {
    const fsx = require('fs');
    const OUT = JSON.parse(fsx.readFileSync(path.join(ROOT, 'fixtures', 'slicer-concentric-reference.json'), 'utf8')).shapes;
    const REF = JSON.parse(fsx.readFileSync(path.join(ROOT, 'fixtures', 'slicer-archimedean-reference.json'), 'utf8')).shapes;
    const plen = p => { let l = 0; for (let i = 1; i < p.pts.length; i++) l += Math.hypot(p.pts[i][0] - p.pts[i - 1][0], p.pts[i][1] - p.pts[i - 1][1]); return l; };
    const opt = (over) => SL.defaultsFor(0.4, Object.assign({ layerMm: 0.2, outerWallWidthMm: 0.42, innerWallWidthMm: 0.45, infillWidthMm: 0.42, topShellLayers: 5, bottomShellLayers: 3, minSparseAreaMm2: 0,
      solidPattern: 'archimedeanchords', sparsePattern: 'archimedeanchords' }, over));
    const objs = OUT.map(sh => ({ name: sh.name, soup: prism(sh.outline, 0, 9.8) }));
    const fills = (ob, li) => ob.layers[li].paths.filter(p => !/wall/i.test(p.feature));
    const dseg = (p, a, b) => { const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy, t = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0; return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy); };
    /* where the spiral starts: the path end furthest from the outline */
    const startOf = (paths, outline) => { let best = null; paths.forEach(p => [p.pts[0], p.pts[p.pts.length - 1]].forEach(e => { let d = Infinity; outline.forEach((a, i) => { d = Math.min(d, dseg(e, a, outline[(i + 1) % outline.length])); }); if (!best || d > best.d) best = { d, e }; })); return best.e; };
    const solid = SL.sliceObjects(objs, opt({}), wasm);
    let wStart = 0, wLen = 0, wPaths = 0, kinds = 0;
    REF.forEach((sh, k) => {
      const mine = fills(solid.objects[k], 1), st = startOf(mine, OUT[k].outline);
      wStart = Math.max(wStart, Math.hypot(st[0] - sh.solid.start[0], st[1] - sh.solid.start[1]));
      wLen = Math.max(wLen, Math.abs(mine.reduce((a, p) => a + plen(p), 0) / sh.solid.length - 1));
      wPaths = Math.max(wPaths, Math.abs(mine.length - sh.solid.paths));
      if (mine.every(p => p.feature === 'Internal solid infill' && !p.closed && p.width === 0.42)) kinds++;
    });
    check('seven shapes, a solid layer: the spiral starts where Bambu\'s does (within 0.01 mm) - the middle of the region\'s box in the 45 degree frame', wStart < 0.01, wStart.toFixed(4));
    check('...the length laid within 0.6 % of Bambu\'s', wLen < 0.006, (wLen * 100).toFixed(2) + ' %');
    check('...cut into as many paths as Bambu\'s, within 1', wPaths <= 1, 'worst ' + wPaths);
    check('...Internal solid infill, open, at the infill\'s width', kinds === REF.length, kinds + '/' + REF.length);
    const sq = fills(solid.objects[OUT.findIndex(sh => sh.name === 'square')], 1), first = sq[0].pts;
    const c0 = first[0], turn = (q) => Math.atan2(q[1] - c0[1], q[0] - c0[0]);
    check('from the centre one straight stroke a spacing long at 135 degrees', Math.abs(Math.hypot(first[1][0] - c0[0], first[1][1] - c0[1]) - SL.spacingOf(0.42, 0.2)) < 1e-6 && Math.abs(turn(first[1]) - 3 * Math.PI / 4) < 1e-6);
    /* every point of it: a spacing out for the stroke, and one more for every turn made since, going counter-clockwise */
    let acc = 0, off = 0, back = 0;
    const sB2 = SL.spacingOf(0.42, 0.2);
    for (let i = 2; i < first.length && acc < 6 * Math.PI; i++) {
      let d = turn(first[i]) - turn(first[i - 1]); if (d < -Math.PI) d += 2 * Math.PI;
      if (d <= 0) back++;
      acc += d;
      off = Math.max(off, Math.abs(Math.hypot(first[i][0] - c0[0], first[i][1] - c0[1]) - sB2 * (1 + acc / (2 * Math.PI))));
    }
    check('...then counter-clockwise, one spacing further out with every turn (three turns, every point within 0.001 mm)', acc >= 6 * Math.PI && back === 0 && off < 1e-3, off.toExponential(1));
    const near = (A, B) => A.length === B.length && A.every((p, k) => p.pts.length === B[k].pts.length && p.pts.every((q, m) => Math.hypot(q[0] - B[k].pts[m][0], q[1] - B[k].pts[m][1]) < 1e-6));
    check('the same on the next layer: the spiral is not turned with the layer', near(fills(solid.objects[0], 1), fills(solid.objects[0], 2)));
    check('the first layer is the Bottom surface and the top the Top surface, in the spiral', fills(solid.objects[0], 0).every(p => p.feature === 'Bottom surface') && fills(solid.objects[0], 48).every(p => p.feature === 'Top surface') &&
      Math.abs(fills(solid.objects[0], 0).reduce((a, p) => a + plen(p), 0) / fills(solid.objects[0], 1).reduce((a, p) => a + plen(p), 0) - 1) < 0.01);
    /* sparse, at the reference's own sparse width (0.45): the spacing over the density, about the object's box */
    const sparse = SL.sliceObjects(objs, opt({ infillWidthMm: 0.45 }), wasm);
    let sStart = 0, sLen = 0;
    REF.forEach((sh, k) => {
      const mine = fills(sparse.objects[k], 3);
      if (sh.name !== 'triangle_right') { const st = startOf(mine, OUT[k].outline); sStart = Math.max(sStart, Math.hypot(st[0] - sh.sparse.start[0], st[1] - sh.sparse.start[1])); }
      sLen = Math.max(sLen, Math.abs(mine.reduce((a, p) => a + plen(p), 0) / sh.sparse.length - 1));
    });
    check('a sparse layer: the spiral starts where Bambu\'s does (within 0.01 mm) - the middle of the object\'s own box', sStart < 0.01, sStart.toFixed(4));
    check('...the length laid within 15 % of Bambu\'s (the spiral is the same; the joins along the walls differ)', sLen < 0.15, (sLen * 100).toFixed(1) + ' %');
    const sp = fills(sparse.objects[OUT.findIndex(sh => sh.name === 'square')], 3)[0].pts, pitch = SL.spacingOf(0.45, 0.2) / 0.15;
    check('...its first stroke the spacing over the density long (0.407 / 0.15 = 2.713)', Math.abs(Math.hypot(sp[1][0] - sp[0][0], sp[1][1] - sp[0][1]) - pitch) < 1e-6, f4(pitch));
    check('...every sparse layer the same lines: each lies on the one below', near(fills(sparse.objects[3], 3), fills(sparse.objects[3], 20)));
    check('...and every line inside the walls', sparse.objects.every((ob, k) => fills(ob, 3).every(p => p.pts.every(q => SL.inside([OUT[k].outline], q[0], q[1])))));
    /* clipLine on its own: a line through a square with a square hole */
    const cl = SL.clipLine([[-5, 5], [15, 5]], [[[0, 0], [10, 0], [10, 10], [0, 10]], [[4, 4], [4, 6], [6, 6], [6, 4]]]);
    check('clipLine: a line across a square with a hole is two pieces, each end on the outline it meets', cl.length === 2 && Math.abs(cl[0].pts[0][0]) < 1e-9 && Math.abs(cl[0].pts[cl[0].pts.length - 1][0] - 4) < 1e-9 &&
      Math.abs(cl[1].pts[0][0] - 6) < 1e-9 && Math.abs(cl[1].pts[cl[1].pts.length - 1][0] - 10) < 1e-9 && cl[0].a.p === 0 && cl[0].b.p === 1 && cl[1].a.p === 1 && cl[1].b.p === 0);
    check('the lists\' name for it', SL.patternLabel('archimedeanchords') === 'archimedean chords');
  }

  section('Hilbert curve and 3D honeycomb - against a real Bambu slice (fixtures/slicer-hilbert-honeycomb-reference.json, docs/SLICER.md "Hilbert curve", "3D honeycomb")');
  {
    const fsx = require('fs');
    const OUT = JSON.parse(fsx.readFileSync(path.join(ROOT, 'fixtures', 'slicer-concentric-reference.json'), 'utf8')).shapes;
    const REF = JSON.parse(fsx.readFileSync(path.join(ROOT, 'fixtures', 'slicer-hilbert-honeycomb-reference.json'), 'utf8')).layers;
    const dseg = (p, a, b) => { const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy, t = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0; return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy); };
    /* how far a point is from the nearest of the paths' lines */
    const off = (q, paths) => { let d = Infinity; paths.forEach(p => { for (let i = 1; i < p.pts.length; i++) { const e = dseg(q, p.pts[i - 1], p.pts[i]); if (e < d) d = e; } }); return d; };
    const plen = p => { let l = 0; for (let i = 1; i < p.pts.length; i++) l += Math.hypot(p.pts[i][0] - p.pts[i - 1][0], p.pts[i][1] - p.pts[i - 1][1]); return l; };
    const opt = (over) => SL.defaultsFor(0.4, Object.assign({ layerMm: 0.2, outerWallWidthMm: 0.42, innerWallWidthMm: 0.45, infillWidthMm: 0.42, topShellLayers: 5, bottomShellLayers: 3, minSparseAreaMm2: 0,
      solidPattern: 'hilbertcurve', sparsePattern: '3dhoneycomb' }, over));
    const objs = OUT.map(sh => ({ name: sh.name, soup: prism(sh.outline, 0, 6) }));
    const fills = (ob, li, kind) => ob.layers[li].paths.filter(p => kind === 'sparse' ? p.feature === 'Sparse infill' : !/wall|Sparse/i.test(p.feature));
    const solid = SL.sliceObjects(objs, opt({}), wasm);
    let hw = 0, hn = 0, hon = 0, hl = 0, kinds = 0, hs = 0;
    REF.filter(r => r.what === 'solid').forEach(r => {
      const k = OUT.findIndex(sh => sh.name === r.shape), mine = fills(solid.objects[k], r.layer - 1, 'solid');
      r.points.forEach(q => { const d = off(q, mine); hn++; if (d < 0.03) { hw = Math.max(hw, d); hon++; } });
      hl = Math.max(hl, Math.abs(mine.reduce((a, p) => a + plen(p), 0) / r.length - 1));
      if (mine.every(p => p.feature === r.feature && !p.closed)) kinds++;
      hs++;
    });
    /* two of the 420 lie on a join Bambu makes between two cut ends, not on the curve */
    check('Hilbert curve, seven shapes, a solid layer: the points pinned on Bambu\'s line lie on this one (within 0.03 mm; all but 2 of 420)', hn - hon <= 2, hon + ' of ' + hn + ', worst of them ' + hw.toFixed(4));
    check('...the length laid within 5 % of Bambu\'s (the curve is the same; more cut ends are joined along the walls here)', hl < 0.05, (hl * 100).toFixed(1) + ' %');
    check('...Internal solid infill, in open lines', kinds === hs, kinds + '/' + hs);
    const sq = fills(solid.objects[OUT.findIndex(sh => sh.name === 'square')], 1, 'solid'), sB = SL.spacingOf(0.42, 0.2);
    let strokes = 0, onGrid = 0;
    sq.forEach(p => { for (let i = 1; i < p.pts.length; i++) { const dx = p.pts[i][0] - p.pts[i - 1][0], dy = p.pts[i][1] - p.pts[i - 1][1], l = Math.hypot(dx, dy); if (l < 0.3) continue; strokes++;
      if (Math.abs(Math.abs(dx) - Math.abs(dy)) < 1e-6 && Math.abs(l / sB - Math.round(l / sB)) < 1e-6) onGrid++; } });
    check('its strokes lie at 45 and 135 degrees, whole bead spacings long (the grid is one spacing, turned 45)', strokes > 500 && onGrid / strokes > 0.93, onGrid + ' of ' + strokes);
    check('hilbertPoint: the plain curve - 16 points of the 4 x 4 one, from (0, 0) to (3, 0), each a step from the last',
      [...Array(16).keys()].map(d => SL.hilbertPoint(4, d).join('')).join(' ') === '00 10 11 01 02 03 13 12 22 23 33 32 31 21 20 30');
    const near = (A, B) => A.length === B.length && A.every((p, k) => p.pts.length === B[k].pts.length && p.pts.every((q, m) => Math.hypot(q[0] - B[k].pts[m][0], q[1] - B[k].pts[m][1]) < 1e-6));
    check('the same on the next layer: the curve is not turned with the layer', near(fills(solid.objects[0], 1, 'solid'), fills(solid.objects[0], 2, 'solid')));

    /* 3D honeycomb, at the reference's own sparse width (0.45): 25 layers of it */
    const sparse = SL.sliceObjects(objs, opt({ infillWidthMm: 0.45 }), wasm);
    let cw = 0, cn = 0, cl = 0;
    REF.filter(r => r.what === 'sparse').forEach(r => {
      const k = OUT.findIndex(sh => sh.name === r.shape), mine = fills(sparse.objects[k], r.layer - 1, 'sparse');
      r.points.forEach(q => { cw = Math.max(cw, off(q, mine)); cn++; });
      cl = Math.max(cl, Math.abs(mine.reduce((a, p) => a + plen(p), 0) / r.length - 1));
    });
    check('3D honeycomb, three shapes on layers 5, 8, 10, 13, 15, 18, 20, 23 (both directions, both sides of straight): every point pinned on Bambu\'s lines lies on these (within 0.04 mm)',
          cw < 0.04, cn + ' points, worst ' + cw.toFixed(4));
    check('...the length laid within 12 % of Bambu\'s (the lines are the same; the joins along the walls differ)', cl < 0.12, (cl * 100).toFixed(1) + ' %');
    const at = (L) => SL.honeycomb3dAt(SL.spacingOf(0.45, 0.2), 0.15, 0.2, L * 0.2);
    check('its numbers at 15 %, 0.45 / 0.2: lines 3.580 apart (measured 3.579), the wave 20 layers long', Math.abs(at(5).D - 3.5802) < 1e-3 && at(5).quarter === 5, f4(at(5).D) + ', quarter ' + at(5).quarter);
    check('...layer 5 the widest wave (D / 4 to each side), 10 straight, 15 the widest the other way and along the other axis, 20 straight, 25 as 5',
          Math.abs(at(5).a - at(5).D / 4) < 1e-9 && at(5).family === 0 && Math.abs(at(10).a) < 1e-9 && at(14).family === 0 && Math.abs(at(15).a + at(5).D / 4) < 1e-9 && at(15).family === 1 &&
          Math.abs(at(20).a) < 1e-9 && at(24).family === 1 && Math.abs(at(25).a - at(5).a) < 1e-9 && at(25).family === 0,
          [5, 10, 15, 20, 25].map(L => f4(at(L).a) + '/' + at(L).family).join(' '));
    check('...a flat moves a twentieth of D a layer (0.179): under a layer height, so every layer lies on the last', Math.abs(Math.abs(at(6).a - at(5).a) - at(5).D / 20) < 1e-9 && at(5).D / 20 < 0.2);
    const sqs = fills(sparse.objects[OUT.findIndex(sh => sh.name === 'square')], 9, 'sparse');
    let straight = 0, all = 0;
    sqs.forEach(p => { for (let i = 1; i < p.pts.length; i++) { const dx = p.pts[i][0] - p.pts[i - 1][0], dy = p.pts[i][1] - p.pts[i - 1][1], l = Math.hypot(dx, dy); all += l; if (Math.abs(dx - dy) < 1e-6) straight += l; } });
    check('layer 10 is straight lines at 45 degrees (but for the joins along the walls)', straight / all > 0.7, (straight / all).toFixed(2));
    check('...and every line inside the walls, on every layer', sparse.objects.every((ob, k) => [4, 9, 14, 19].every(li => fills(ob, li, 'sparse').every(p => p.pts.every(q => SL.inside([OUT[k].outline], q[0], q[1]))))));
    check('the solid layers under it stay as they were asked (Hilbert), the sparse ones the honeycomb', fills(sparse.objects[0], 1, 'solid').length > 0 && fills(sparse.objects[0], 9, 'sparse').length > 0 && fills(sparse.objects[0], 9, 'solid').length === 0);
    check('the lists\' names for them', SL.patternLabel('hilbertcurve') === 'hilbert curve' && SL.patternLabel('3dhoneycomb') === '3D honeycomb');
  }

  section('Octagram spiral and gyroid - against a real Bambu slice (fixtures/slicer-octagram-gyroid-reference.json, docs/SLICER.md "Octagram spiral", "Gyroid")');
  {
    const fsx = require('fs');
    const OUT = JSON.parse(fsx.readFileSync(path.join(ROOT, 'fixtures', 'slicer-concentric-reference.json'), 'utf8')).shapes;
    const REF = JSON.parse(fsx.readFileSync(path.join(ROOT, 'fixtures', 'slicer-octagram-gyroid-reference.json'), 'utf8')).layers;
    const dseg = (p, a, b) => { const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy, t = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0; return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy); };
    const off = (q, paths) => { let d = Infinity; paths.forEach(p => { for (let i = 1; i < p.pts.length; i++) { const e = dseg(q, p.pts[i - 1], p.pts[i]); if (e < d) d = e; } }); return d; };
    const plen = p => { let l = 0; for (let i = 1; i < p.pts.length; i++) l += Math.hypot(p.pts[i][0] - p.pts[i - 1][0], p.pts[i][1] - p.pts[i - 1][1]); return l; };
    const opt = (over) => SL.defaultsFor(0.4, Object.assign({ layerMm: 0.2, outerWallWidthMm: 0.42, innerWallWidthMm: 0.45, infillWidthMm: 0.42, topShellLayers: 5, bottomShellLayers: 3, minSparseAreaMm2: 0,
      solidPattern: 'octagramspiral', sparsePattern: 'gyroid' }, over));
    const objs = OUT.map(sh => ({ name: sh.name, soup: prism(sh.outline, 0, 6) }));
    const fills = (ob, li, kind) => ob.layers[li].paths.filter(p => kind === 'sparse' ? p.feature === 'Sparse infill' : !/wall|Sparse/i.test(p.feature));
    const solid = SL.sliceObjects(objs, opt({}), wasm);
    let ow = 0, on = 0, ol = 0;
    REF.filter(r => r.what === 'solid').forEach(r => {
      const k = OUT.findIndex(sh => sh.name === r.shape), mine = fills(solid.objects[k], r.layer - 1, 'solid');
      r.points.forEach(q => { ow = Math.max(ow, off(q, mine)); on++; });
      ol = Math.max(ol, Math.abs(mine.reduce((a, p) => a + plen(p), 0) / r.length - 1));
    });
    check('octagram spiral, seven shapes, a solid layer: every point pinned on Bambu\'s line lies on this one (within 0.02 mm)', ow < 0.02, on + ' points, worst ' + ow.toFixed(4));
    check('...the length laid within 0.5 % of Bambu\'s', ol < 0.005, (ol * 100).toFixed(2) + ' %');
    const sq = fills(solid.objects[OUT.findIndex(sh => sh.name === 'square')], 1, 'solid')[0].pts, c0 = sq[0], sB = SL.spacingOf(0.42, 0.2);
    const rel = sq.slice(0, 19).map(q => [((q[0] - c0[0]) / sB).toFixed(2), ((q[1] - c0[1]) / sB).toFixed(2)].join(',')).join(' ');
    check('from the centre, in spacings: the stroke to (-1, 1), the first star - sides one spacing off the axes, points 1 + sqrt 2 out, notches sqrt 2 out - then out to the next',
          rel === '0.00,0.00 -1.00,1.00 -2.41,1.00 -1.41,0.00 -2.41,-1.00 -1.00,-1.00 -1.00,-2.41 0.00,-1.41 1.00,-2.41 1.00,-1.00 2.41,-1.00 1.41,0.00 2.41,1.00 1.00,1.00 1.00,2.41 0.00,1.41 -2.00,3.41 -2.00,2.00 -4.83,2.00', rel);
    const near = (A, B) => A.length === B.length && A.every((p, k) => p.pts.length === B[k].pts.length && p.pts.every((q, m) => Math.hypot(q[0] - B[k].pts[m][0], q[1] - B[k].pts[m][1]) < 1e-6));
    check('the same on the next layer', near(fills(solid.objects[0], 1, 'solid'), fills(solid.objects[0], 2, 'solid')));

    /* gyroid, at the reference's own sparse width (0.45) */
    const sparse = SL.sliceObjects(objs, opt({ infillWidthMm: 0.45 }), wasm);
    let gw = 0, gn = 0, gl = 0;
    REF.filter(r => r.what === 'sparse').forEach(r => {
      const k = OUT.findIndex(sh => sh.name === r.shape), mine = fills(sparse.objects[k], r.layer - 1, 'sparse');
      r.points.forEach(q => { gw = Math.max(gw, off(q, mine)); gn++; });
      gl = Math.max(gl, Math.abs(mine.reduce((a, p) => a + plen(p), 0) / r.length - 1));
    });
    check('gyroid, three shapes on layers 4, 7 ... 25 (lines along X, along Y and between): every point pinned on Bambu\'s lines lies on these (within 0.08 mm: Bambu writes them in arcs, this in short lines)', gw < 0.08, gn + ' points, worst ' + gw.toFixed(4));
    check('...the length laid within 18 % of Bambu\'s (the lines are the same; the joins along the walls differ)', gl < 0.18, (gl * 100).toFixed(1) + ' %');
    const lam = SL.GYROID_SCALE * SL.spacingOf(0.45, 0.2) / 0.15;
    check('its wavelength at 15 %, 0.45 / 0.2: 6.988 (measured 6.988), the same along X, Y and Z', Math.abs(lam - 6.988) < 2e-3, f4(lam));
    /* the lines lie on the surface itself: cos X sin Y + cos Y sin Z + cos Z sin X = 0 about the object's middle */
    const ob = sparse.objects[OUT.findIndex(sh => sh.name === 'square')], sqo = OUT.find(sh => sh.name === 'square').outline;
    const cx = (Math.min(...sqo.map(q => q[0])) + Math.max(...sqo.map(q => q[0]))) / 2, cy = (Math.min(...sqo.map(q => q[1])) + Math.max(...sqo.map(q => q[1]))) / 2, kk = 2 * Math.PI / lam;
    let worstG = 0, np = 0;
    [5, 9, 13, 17, 21].forEach(li => fills(ob, li, 'sparse').forEach(p => p.pts.forEach(q => {
      if (Math.abs(q[0] - cx) > 9.5 || Math.abs(q[1] - cy) > 9.5) return;                     /* clear of the joins along the walls */
      const X = kk * (q[0] - cx), Y = kk * (q[1] - cy), Z = kk * (li + 1) * 0.2;
      worstG = Math.max(worstG, Math.abs(Math.cos(X) * Math.sin(Y) + Math.cos(Y) * Math.sin(Z) + Math.cos(Z) * Math.sin(X))); np++;
    })));
    check('every point of its lines lies on the gyroid about the object\'s middle (five layers)', np > 500 && worstG < 1e-6, np + ' points, worst ' + worstG.toExponential(1));
    const dirOf = (li) => { let ax = 0, ay = 0; fills(ob, li, 'sparse').forEach(p => { for (let i = 1; i < p.pts.length; i++) { ax += Math.abs(p.pts[i][0] - p.pts[i - 1][0]); ay += Math.abs(p.pts[i][1] - p.pts[i - 1][1]); } }); return ax > ay ? 'X' : 'Y'; };
    /* Z = pi/2 (layer 8.7) the lines run along X, Z = pi (17.5) along Y, towards 3 pi/2 (26.2) along X again */
    check('the lines turn with height: along X at layer 9, along Y at 17, along X again at 25', dirOf(8) === 'X' && dirOf(16) === 'Y' && dirOf(24) === 'X', [8, 16, 24].map(dirOf).join(' '));
    check('...and every line inside the walls', sparse.objects.every((o2, k) => [4, 9, 14, 19].every(li => fills(o2, li, 'sparse').every(p => p.pts.every(q => SL.inside([OUT[k].outline], q[0], q[1]))))));
    check('the lists\' name for the star', SL.patternLabel('octagramspiral') === 'octagram spiral' && SL.patternLabel('gyroid') === 'gyroid');
  }

  section('Cubic, adaptive cubic and honeycomb - against real Bambu slices (fixtures/slicer-cubic-, -adaptivecubic-, -honeycomb-reference.json, docs/SLICER.md)');
  {
    const fsx = require('fs');
    const OUT = JSON.parse(fsx.readFileSync(path.join(ROOT, 'fixtures', 'slicer-concentric-reference.json'), 'utf8')).shapes;
    const dseg = (p, a, b) => { const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy, t = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0; return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy); };
    const off = (q, paths) => { let d = Infinity; paths.forEach(p => { for (let i = 1; i < p.pts.length; i++) { const e = dseg(q, p.pts[i - 1], p.pts[i]); if (e < d) d = e; } }); return d; };
    const plen = p => { let l = 0; for (let i = 1; i < p.pts.length; i++) l += Math.hypot(p.pts[i][0] - p.pts[i - 1][0], p.pts[i][1] - p.pts[i - 1][1]); return l; };
    const opt = (pat) => SL.defaultsFor(0.4, { layerMm: 0.2, outerWallWidthMm: 0.42, innerWallWidthMm: 0.45, infillWidthMm: 0.45, topShellLayers: 5, bottomShellLayers: 3, minSparseAreaMm2: 0, sparsePattern: pat });
    const sparseOf = (ob, li) => ob.layers[li].paths.filter(p => p.feature === 'Sparse infill');
    const slices = {};
    /* a pattern against its reference: each shape sliced at the reference's own height */
    const against = (pat, file) => {
      const REF = JSON.parse(fsx.readFileSync(path.join(ROOT, 'fixtures', file), 'utf8')).layers, shapes = [...new Set(REF.map(r => r.shape))];
      const res = SL.sliceObjects(shapes.map(n => ({ name: n, soup: prism(OUT.find(sh => sh.name === n).outline, 0, REF.find(r => r.shape === n).tall * 0.2) })), opt(pat), wasm);
      slices[pat] = { res, shapes };
      let worst = 0, n = 0, len = 0;
      REF.forEach(r => { const mine = sparseOf(res.objects[shapes.indexOf(r.shape)], r.layer - 1);
        r.points.forEach(q => { worst = Math.max(worst, off(q, mine)); n++; });
        len = Math.max(len, Math.abs(mine.reduce((a, p) => a + plen(p), 0) / r.length - 1)); });
      return { worst, n, len, layers: [...new Set(REF.map(r => r.layer))].join(', ') };
    };
    const cu = against('cubic', 'slicer-cubic-reference.json');
    check('cubic, three shapes of three heights, layers ' + cu.layers + ': every point pinned on Bambu\'s lines lies on these (within 0.03 mm)', cu.worst < 0.03, cu.n + ' points, worst ' + cu.worst.toFixed(4));
    check('...the length laid within 25 % of Bambu\'s (the lines are the same; the joins along the walls differ)', cu.len < 0.25, (cu.len * 100).toFixed(1) + ' %');
    const sB = SL.spacingOf(0.45, 0.2);
    const fam = (paths) => { const m = {}; paths.forEach(p => { for (let i = 1; i < p.pts.length; i++) { const dx = p.pts[i][0] - p.pts[i - 1][0], dy = p.pts[i][1] - p.pts[i - 1][1], l = Math.hypot(dx, dy); if (l < 3) continue;
      const a = ((Math.round(Math.atan2(dy, dx) * 180 / Math.PI) % 180) + 180) % 180; m[a] = (m[a] || 0) + l; } }); return m; };
    const sqC = slices.cubic.res.objects[slices.cubic.shapes.indexOf('square')], fc = fam(sparseOf(sqC, 19));
    check('its three families lie at 45, 105 and 165 degrees', fc[45] > 20 && fc[105] > 20 && fc[165] > 20, JSON.stringify(Object.keys(fc)));
    const at4 = SL.cubicAt([0, 0], Math.PI / 4, 0.8), at5 = SL.cubicAt([0, 0], Math.PI / 4, 1.0);
    check('...each slides the layer height over sqrt 2 a layer (0.1414), the middle family against the other two; all three through the centre at the plate',
          at4.every((d, k) => Math.abs((at5[k] - d) - [-1, 1, -1][k] * 0.2 / Math.SQRT2) < 1e-9) && SL.cubicAt([0, 0], Math.PI / 4, 0).every(d => Math.abs(d) < 1e-12), at4.map(f4).join(' '));
    const ac = against('adaptivecubic', 'slicer-adaptivecubic-reference.json');
    check('adaptive cubic, three shapes of three heights, layers ' + ac.layers + ': every point pinned on Bambu\'s lines lies on these (within 0.06 mm)', ac.worst < 0.06, ac.n + ' points, worst ' + ac.worst.toFixed(4));
    check('...the length laid within 35 % of Bambu\'s (few lines a layer, so the joins along the walls are a large share)', ac.len < 0.35, (ac.len * 100).toFixed(1) + ' %');
    const fa = fam(sparseOf(slices.adaptivecubic.res.objects[slices.adaptivecubic.shapes.indexOf('pentagon')], 49));
    check('its three families lie at 0, 60 and 120 degrees', fa[60] > 10 && fa[120] > 10, JSON.stringify(Object.keys(fa)));
    const box = [0, 0, 0, 20, 0, 0, 20, 30, 0, 0, 30, 0, 0, 0, 40, 20, 0, 40, 20, 30, 40, 0, 30, 40], lat = SL.adaptiveCubicLattice(box, 9);
    const mid = lat.at(20).map((d, k) => d - (-10 * Math.sin(k * Math.PI / 3) + 15 * Math.cos(k * Math.PI / 3)));
    check('its lattice: lines 11.023 apart (cubes 9 on edge: 3 x 0.45 / 15 %), all three through the middle of the object\'s box at half its height',
          Math.abs(lat.pitch - 11.0227) < 1e-3 && mid.every(d => Math.abs(d) < 1e-9), f4(lat.pitch) + ' ' + mid.map(d => d.toExponential(0)).join(' '));
    const hc = against('honeycomb', 'slicer-honeycomb-reference.json');
    check('honeycomb, three shapes, layers ' + hc.layers + ' (the three directions, twice round): every point pinned on Bambu\'s lines lies on these (within 0.02 mm)', hc.worst < 0.02, hc.n + ' points, worst ' + hc.worst.toFixed(4));
    check('...the length laid within 15 % of Bambu\'s', hc.len < 0.15, (hc.len * 100).toFixed(1) + ' %');
    const sqH = slices.honeycomb.res.objects[slices.honeycomb.shapes.indexOf('square')];
    const main = (li) => { const m = fam2(sparseOf(sqH, li)); return +Object.keys(m).sort((a, b) => m[b] - m[a])[0]; };
    function fam2(paths) { const m = {}; paths.forEach(p => { for (let i = 1; i < p.pts.length; i++) { const dx = p.pts[i][0] - p.pts[i - 1][0], dy = p.pts[i][1] - p.pts[i - 1][1], l = Math.hypot(dx, dy); if (l < 1.5) continue;
      const a = ((Math.round(Math.atan2(dy, dx) * 180 / Math.PI) % 180) + 180) % 180; m[a] = (m[a] || 0) + l; } }); return m; }
    check('its zigzags run along 135 degrees on layer 4, 75 on layer 5, 15 on layer 6, and round again', [3, 4, 5, 6, 7, 8].map(main).join(' ') === '135 75 15 135 75 15', [3, 4, 5, 6, 7, 8].map(main).join(' '));
    const W = sB / 0.15, aH = 2 * W / Math.sqrt(3), longest = Math.max(...sparseOf(sqH, 3).flatMap(p => p.pts.slice(1).map((q, i) => { const dx = q[0] - p.pts[i][0], dy = q[1] - p.pts[i][1]; return Math.abs(dx + dy) < 1e-6 ? Math.hypot(dx, dy) : 0; })));
    check('the hexagons: 5.427 across the flats (two spacings over the density), a side 3.133; a doubled wall\'s stroke the side and a bit (3.368: half a spacing off the true edge at each end)',
          Math.abs(2 * W - 5.4277) < 1e-3 && Math.abs(longest - (aH + sB / Math.sqrt(3))) < 1e-3, f4(2 * W) + ' ' + f4(aH) + ' ' + f4(longest));
    check('every line of all three inside the walls', ['cubic', 'adaptivecubic', 'honeycomb'].every(pt => slices[pt].res.objects.every((ob, k) => [5, 20, 60].every(li =>
          sparseOf(ob, li).every(p => p.pts.every(q => SL.inside([OUT.find(sh => sh.name === slices[pt].shapes[k]).outline], q[0], q[1])))))));
    check('the lists\' name for adaptive cubic', SL.patternLabel('adaptivecubic') === 'adaptive cubic' && SL.patternLabel('cubic') === 'cubic' && SL.patternLabel('honeycomb') === 'honeycomb');
  }

  section('Lightning - what holds the roofs up, by the measures of a real Bambu slice (fixtures/slicer-lightning-reference.json, docs/SLICER.md "Lightning")');
  {
    const fsx = require('fs');
    const OUT = JSON.parse(fsx.readFileSync(path.join(ROOT, 'fixtures', 'slicer-concentric-reference.json'), 'utf8')).shapes;
    const REF = JSON.parse(fsx.readFileSync(path.join(ROOT, 'fixtures', 'slicer-lightning-reference.json'), 'utf8')).shapes;
    const plen = p => { let l = 0; for (let i = 1; i < p.pts.length; i++) l += Math.hypot(p.pts[i][0] - p.pts[i - 1][0], p.pts[i][1] - p.pts[i - 1][1]); return l; };
    const o = SL.defaultsFor(0.4, { layerMm: 0.2, outerWallWidthMm: 0.42, innerWallWidthMm: 0.45, infillWidthMm: 0.45, topShellLayers: 5, bottomShellLayers: 3, minSparseAreaMm2: 0, sparsePattern: 'lightning' });
    const res = SL.sliceObjects(REF.map(r => ({ name: r.name, soup: prism(OUT.find(sh => sh.name === r.name).outline, 0, r.tall * 0.2) })), o, wasm);
    const sp = (ob, li) => ob.layers[li].paths.filter(p => p.feature === 'Sparse infill'), lay = (ob, li) => sp(ob, li).reduce((a, p) => a + plen(p), 0);
    const dens = REF.map((r, k) => lay(res.objects[k], r.lastSparseLayer - 1) / r.areaInsideWalls), densRef = REF.map(r => r.lengthUnderTop[0][1] / r.areaInsideWalls);
    check('under the top shell the lines are sqrt 2 spacings over the density apart: 0.23 - 0.27 mm of line a mm2 inside the walls on all seven shapes (Bambu\'s trees: 0.26 - 0.27)',
          dens.every(d => d > 0.225 && d < 0.275) && densRef.every(d => d > 0.25 && d < 0.275), dens.map(d => d.toFixed(3)).join(' ') + ' | ' + densRef.map(d => d.toFixed(3)).join(' '));
    const tot = REF.map((r, k) => { let t = 0; for (let li = 3; li < r.lastSparseLayer; li++) t += lay(res.objects[k], li); return t / r.totalLength; });
    check('the whole object\'s sparse infill is as much as Bambu\'s: 0.65 - 1.35 x on each shape, within 5 % over the seven together',
          tot.every(t => t > 0.65 && t < 1.35) && Math.abs(REF.reduce((a, r, k) => a + tot[k] * r.totalLength, 0) / REF.reduce((a, r) => a + r.totalLength, 0) - 1) < 0.05,
          tot.map(t => t.toFixed(2)).join(' ') + ' | together ' + (REF.reduce((a, r, k) => a + tot[k] * r.totalLength, 0) / REF.reduce((a, r) => a + r.totalLength, 0)).toFixed(3));
    const at20 = REF.map((r, k) => lay(res.objects[k], r.lastSparseLayer - 21) / Math.max(1, r.lengthUnderTop[3][1]));
    check('...and 20 layers under the top, 0.6 - 1.4 x Bambu\'s on each', at20.every(t => t > 0.6 && t < 1.4), at20.map(t => t.toFixed(2)).join(' '));
    const firsts = REF.map((r, k) => { for (let li = 3; li < r.lastSparseLayer; li++) if (lay(res.objects[k], li) > 0.5) return li + 1; return 0; });
    check('nothing is laid in the lower layers: the first sparse line is over 100 layers up on every shape (Bambu\'s: layer ' + REF.map(r => r.firstLayerWithInfill).join(', ') + ')',
          firsts.every(f => f > 100), firsts.join(', '));
    const sq = res.objects[REF.findIndex(r => r.name === 'square')], rs = REF.find(r => r.name === 'square'), topLi = rs.lastSparseLayer - 1;
    const stubs = (li) => sp(sq, li).map(p => plen(p)).sort((a, b) => b - a);
    check('the roof lines run from wall to wall at 45 degrees; a layer down each is two stubs, every stub one layer height shorter than the one over it',
          sp(sq, topLi).every(p => Math.abs((p.pts[1][0] - p.pts[0][0]) - (p.pts[1][1] - p.pts[0][1])) < 1e-6) && sp(sq, topLi - 1).length === 2 * sp(sq, topLi).length &&
          Math.abs(stubs(topLi - 5)[0] - stubs(topLi - 6)[0] - 0.2) < 1e-6, stubs(topLi)[0].toFixed(2) + ' -> ' + stubs(topLi - 1)[0].toFixed(2) + ', ' + stubs(topLi - 5)[0].toFixed(2) + ' -> ' + stubs(topLi - 6)[0].toFixed(2));
    /* every stub lies on a longer one below it, or on the wall's end of it: the layer below has a stub on the same line, at least as long */
    const key = p => Math.round((p.pts[0][1] - p.pts[0][0]) * 1e3);
    let held = 0, all = 0;
    for (let li = topLi - 30; li <= topLi - 1; li++) { const below = sp(sq, li - 1); sp(sq, li).forEach(p => { all++; if (plen(p) <= 0.2 + 0.45 + 1e-6 || below.some(q => key(q) === key(p) && plen(q) >= plen(p) - 0.2 - 1e-6)) held++; }); }
    check('every stub lies on the one below it (one layer height shorter at most), down to where it is no longer than a line is wide', held === all, held + ' of ' + all);
    /* a roof in the middle of a part: a 40 x 40 block with a 20 x 20 x 10 pocket in its top - the pocket's floor is a roof too */
    const pocket = prism(rect0(0, 40, 0, 40), 0, 20).concat(prism(rect0(0, 40, 0, 10), 20, 30), prism(rect0(0, 40, 30, 40), 20, 30), prism(rect0(0, 10, 10, 30), 20, 30), prism(rect0(30, 40, 10, 30), 20, 30));
    const rp = SL.sliceObjects([{ name: 'pocket', soup: pocket }], o, wasm).objects[0], mid = (li) => sp(rp, li).filter(p => { const a = p.pts[0], b = p.pts[1];      /* does the line pass through the middle 12 x 12? */
      for (let t = 0; t <= 1; t += 0.01) { const x = a[0] + (b[0] - a[0]) * t, y = a[1] + (b[1] - a[1]) * t; if (x > 14 && x < 26 && y > 14 && y < 26) return true; } return false; }).length;
    check('a pocket\'s floor inside a part is a roof too: lines under it (layer 95), none there higher up beside the pocket (layer 120)', mid(94) > 3 && mid(119) === 0 && sp(rp, 119).length > 0, mid(94) + ' / ' + mid(119));
    check('the lists\' name', SL.patternLabel('lightning') === 'lightning');
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(err => { console.error(err); process.exit(1); });

function zMinOf(s) { let m = Infinity; for (let i = 2; i < s.length; i += 3) if (s[i] < m) m = s[i]; return m; }
function zMaxOf(s) { let m = -Infinity; for (let i = 2; i < s.length; i += 3) if (s[i] > m) m = s[i]; return m; }
