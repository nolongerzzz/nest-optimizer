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
 */
'use strict';

const path = require('path');
const ROOT = path.join(__dirname, '..');
const SL = require('../nso_slicer.js');
const G = require('../nso-gcode-lines.js');
const { readSTL } = require('./nso_stl_io.js');

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
    check('the header says it is not a print file', /NOT A PRINT FILE/.test(r.gcode) && !/M104|M109|M140|M190|G28/.test(r.gcode));
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

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(err => { console.error(err); process.exit(1); });

function zMinOf(s) { let m = Infinity; for (let i = 2; i < s.length; i += 3) if (s[i] < m) m = s[i]; return m; }
function zMaxOf(s) { let m = -Infinity; for (let i = 2; i < s.length; i += 3) if (s[i] > m) m = s[i]; return m; }
