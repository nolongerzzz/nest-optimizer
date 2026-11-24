#!/usr/bin/env node
/*
 * tools/nso_slicer_arachne_reference.js - Studio's Arachne walls on real test pieces, written to fixtures/slicer-arachne-reference.json
 * for slicer:test ("Arachne, measured").
 *
 *   node tools/nso_slicer_arachne_reference.js <walls-tester4.3mf> <walls-tester_arachne.gcode.3mf> <thin_board_arachne.3mf> <thin_board_one_plate_arachne.gcode.3mf>
 *                                              [<walls-tester_classic.gcode.3mf> <thin_board_one_plate_classic.gcode.3mf>]
 *
 * With the two Classic slices too, the same pieces' Classic walls and Gap infill (slicer:test "Classic, measured").
 *
 * The owner's two Studio projects (2026-11-20), each with its mesh and Studio's own Arachne slice of it:
 *   walls tester   Erik's wall-thickness benchmark: tubes 0.2 - 1.6 mm thick and L legs 0.4 - 3.2 mm, PLA Matte (flow 0.98)
 *   thin board     a board of thin bars 0.15 - 2.0 mm, PETG (flow 0.94)
 * Both: Studio 02.09, A1 mini 0.4, Arachne with Studio's levers, 2 walls, outer 0.42 / inner 0.45, 0.2 layers.
 *
 * Kept per sample: its cross-section at one mid-height layer (the outline NSO's slicer cuts from the mesh, simplified to 2 um) and the walls
 * Studio laid inside it on that layer - length laid at each width (0.01 mm steps) and the plastic (length x width). Only the plain samples:
 * a piece whose outline has more than 200 points (a raised digit) is left out. The meshes themselves - the designers' - are not kept.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const SL = require('../nso_slicer.js');
const PL = require('../nso-print-planner.js');
const G = require('../nso-gcode-lines.js');
const R = require('../nso-3mf-read.js');

const ROOT = path.join(__dirname, '..');
const r4 = (v) => Math.round(v * 1e4) / 1e4;

async function setOf(wasm, projFile, objName, gcodeFile, layer, label, gen) {
  gen = gen || 'arachne';
  const proj = await R.parse3MF(new Uint8Array(fs.readFileSync(projFile)), { name: 'p' });
  const ob = proj.objects.find((o) => o.name === objName);
  if (!ob) throw new Error(projFile + ': no object ' + objName);
  const zip = R.openZip(new Uint8Array(fs.readFileSync(gcodeFile)));
  const txt = (b) => new TextDecoder().decode(b);
  const names = zip.names(), gname = names.find((n) => /^Metadata\/plate_\d+\.gcode$/.test(n));
  const plateN = gname.match(/plate_(\d+)/)[1];
  const gcode = txt(await zip.read(gname));
  const plate = JSON.parse(txt(await zip.read('Metadata/plate_' + plateN + '.json')));
  const cfg = JSON.parse(txt(await zip.read('Metadata/project_settings.config')));
  /* the mesh where Studio placed it (a second plate sits along X in the project) */
  const bb = plate.bbox_objects[0].bbox, p = ob.positions;
  let mnx = Infinity, mny = Infinity;
  for (let i = 0; i < p.length; i += 3) { mnx = Math.min(mnx, p[i]); mny = Math.min(mny, p[i + 1]); }
  const soup = Float32Array.from(p, (v, i) => i % 3 === 0 ? v - mnx + bb[0] : i % 3 === 1 ? v - mny + bb[1] : v);
  const eng = PL.engineOptions(cfg);
  const res = SL.sliceObjects([{ name: objName, soup }], SL.defaultsFor(eng.nozzleMm, Object.assign({}, eng.over, { wallGenerator: gen, emitGcode: false })), wasm);
  const L = res.objects[0].layers[layer];
  const g = SL.geometry(wasm);
  const parts = g.parts(g.simplify(g.of(L.sectionPolys, 'Positive'), 0.002)).map((pc) => g.polys(pc)).filter((ps) => ps.reduce((n, q) => n + q.length, 0) <= 200);
  g.free();
  const moves = G.parseGcode(gcode).moves.filter((m) => m.layer === layer && m.width > 0 && /wall|Gap infill/.test(m.feature));
  const inside = (P, x, y) => { let inn = false; for (const q of P) for (let i = 0, j = q.length - 1; i < q.length; j = i++) { const [xi, yi] = q[i], [xj, yj] = q[j]; if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inn = !inn; } return inn; };
  const samples = parts.map((polys) => ({ polys: polys.map((q) => q.map((v) => [r4(v[0]), r4(v[1])])), walls: {}, plastic: 0, gap: 0 }));
  moves.forEach((m) => {
    const x = (m.x0 + m.x1) / 2, y = (m.y0 + m.y1) / 2, k = samples.findIndex((s) => inside(s.polys, x, y));
    if (k < 0) return;
    const w = (Math.round(m.width * 100) / 100).toFixed(2);
    samples[k].walls[w] = r4((samples[k].walls[w] || 0) + m.length);
    samples[k].plastic = r4(samples[k].plastic + m.length * m.width);
    if (m.feature === 'Gap infill') samples[k].gap = r4(samples[k].gap + m.length * m.width);
  });
  const fr = (k) => { const v = cfg[k]; const x = parseFloat(Array.isArray(v) ? v[0] : String(v == null ? '1' : v).split(',')[0]); return isFinite(x) ? x : 1; };
  const keep = samples.filter((s) => s.plastic > 0.5);
  return {
    name: label, generator: gen, file: path.basename(gcodeFile).replace(/^[0-9a-f]{8}-/, ''), studio: (/^; BambuStudio ([\d.]+)/m.exec(gcode) || [])[1], layer, printZ: r4(L.printZ),
    flow: r4(fr('filament_flow_ratio') * fr('print_flow_ratio')),
    settings: { outerWallWidthMm: eng.over.outerWallWidthMm, innerWallWidthMm: eng.over.innerWallWidthMm, wallLoops: eng.over.wallLoops, layerMm: eng.over.layerMm,
      wallTransitionAngleDeg: eng.over.wallTransitionAngleDeg, wallTransitionFilterMargin: eng.over.wallTransitionFilterMargin, wallTransitionLength: eng.over.wallTransitionLength,
      wallDistributionCount: eng.over.wallDistributionCount, minBeadWidth: eng.over.minBeadWidth, minFeatureSize: eng.over.minFeatureSize, detectThinWall: eng.over.detectThinWall },
    samples: keep
  };
}

(async () => {
  const [wt3mf, wtG, tb3mf, tbG, wtC, tbC] = process.argv.slice(2);
  if (!tbG) { console.error('usage: node tools/nso_slicer_arachne_reference.js <walls-tester4.3mf> <walls-tester_arachne.gcode.3mf> <thin_board_arachne.3mf> <thin_board_one_plate_arachne.gcode.3mf>'); process.exit(2); }
  const wasm = await SL.loadKernel({});
  const sets = [await setOf(wasm, wt3mf, 'Body38', wtG, 40, 'walls tester'), await setOf(wasm, tb3mf, 'one_plate_arachne.stl', tbG, 20, 'thin board')];
  if (wtC) sets.push(await setOf(wasm, wt3mf, 'Body38', wtC, 40, 'walls tester, Classic', 'classic'));
  if (tbC) sets.push(await setOf(wasm, tb3mf, 'one_plate_classic.stl', tbC, 20, 'thin board, Classic', 'classic'));
  const out = {
    source: 'Studio\'s Arachne walls on two real test pieces, the owner\'s Studio projects with their meshes and Studio\'s own slices (2026-11-20): Erik\'s ' +
      'wall-thickness benchmark (tubes 0.2 - 1.6 mm, L legs 0.4 - 3.2 mm) and a board of thin bars (0.15 - 2.0 mm). Per sample: its cross-section at one ' +
      'mid-height layer and the walls Studio laid in it there - length at each width, and plastic. Made by tools/nso_slicer_arachne_reference.js; the ' +
      'meshes are not kept. docs/SLICER.md "Arachne".',
    sets
  };
  const dest = path.join(ROOT, 'fixtures', 'slicer-arachne-reference.json');
  fs.writeFileSync(dest, JSON.stringify(out) + '\n');
  console.log('wrote', path.relative(ROOT, dest), (fs.statSync(dest).size / 1024).toFixed(0) + ' KB:', sets.map((s) => s.name + ' ' + s.samples.length + ' samples (layer ' + s.layer + ', flow ' + s.flow + ')').join('; '));
})();
