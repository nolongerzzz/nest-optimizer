#!/usr/bin/env node
/*
 * Task 7 - is the in-house slicer worth trusting? Measured against REAL
 * Bambu Studio behaviour, not against itself.
 *
 *   node tools/nso_slicer_bambu_check.js
 *
 * READ docs/SLICER.md section 5 for the write-up. What this repo has, and so
 * what can honestly be compared:
 *
 *   A. The two real Bambu slices in fixtures/3mf/ (the user's own projects,
 *      0.6 mm nozzle, 0.3 mm layers). Their archives carry the G-code and the
 *      settings but NOT the source meshes (3D/3dmodel.model is empty), so each
 *      piece is RECONSTRUCTED from evidence that does not depend on the wall /
 *      infill / support logic under test:
 *        supportwithinsupport - the lower block's 30.000 x 30.000 footprint is
 *          Metadata/plate_1.json's bbox_objects, independent of every move;
 *          its height, the ribs and the upper box come from the layers they
 *          occupy and their outer walls, at the inset measured in section 1.
 *        tabletop - the four X-shaped legs and the 70 x 70 slab from their
 *          outer walls, at the same measured inset; every value came out round
 *          (1.000 mm cards 14.000 mm long, a 70.000 mm slab), which is the
 *          evidence the reconstruction is the part and not a fit to it.
 *      Outer-wall POSITION is therefore partly circular (the inset was used to
 *      reconstruct), and is reported as a consistency check only. Wall COUNT,
 *      inner-wall position, shell layers, infill and every overhang /
 *      support-need call are independent.
 *   B. The tape strut / tree artifact (tools/nso_support_slice_artifact.js),
 *      whose only real Bambu record is the one the user relayed: "the tree and
 *      the piece overlapping at layer 91" on the pre-interface build. There is
 *      NO Bambu G-code of that artifact in this repo, so its wall count and
 *      layer structure can only be compared with what Bambu does to its OWN
 *      trees (docs/SUPPORT-TREE-SHAPE.md) - said so where it is used.
 *
 *   C. The top_clip_x2 coupon export (npm run support:print-export, the
 *      Supports card's build): NSO's 0.40 sheet, which Bambu Studio prints
 *      with classic walls + Detect thin wall as ONE pass per line (the
 *      owner's print, 2026-10-20). NSO's slice of it - read by the same
 *      audit tool that reads Bambu's (tools/nso_slicer_audit.js sheetAudit)
 *      - against the record (Bambu: 54 extrusions, ~434 mm, a slab sheet
 *      layer), and against the owner's own Bambu G-code of this export
 *      (fixtures/supports/top_clip_x2_supports.gcode.3mf, breakawayV1): per
 *      sheet layer one connected drawing in both, every line printed, total
 *      mm within 10 % (Bambu's 2 runs a layer against NSO's 1 a finding).
 *
 * Agreement is asserted (a failure is a regression). Disagreement is printed
 * as FINDING and pinned where it is stable, so it cannot silently change.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SL = require('../nso_slicer.js');
const G = require('../nso-gcode-lines.js');
const R = require('../nso-3mf-read.js');
const { readSTL } = require('./nso_stl_io.js');

let pass = 0, fail = 0;
const findings = [];
function check(what, cond, got) {
  if (cond) { pass++; console.log('  ok   ' + what + (got !== undefined ? '  [' + got + ']' : '')); }
  else { fail++; console.log('  FAIL ' + what + (got !== undefined ? '  [' + got + ']' : '')); }
}
function finding(text) { findings.push(text); console.log('  FINDING ' + text); }
function section(t) { console.log('\n== ' + t); }
const f3 = v => (+v).toFixed(3);

// ---------------------------------------------------------------------------
// geometry helpers - boxes as outward-wound triangle soups
// ---------------------------------------------------------------------------
function quad(out, a, b, c, d) { out.push(...a, ...b, ...c, ...a, ...c, ...d); }
/** A prism over a CCW footprint [[x,y]..] from z0 to z1. */
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
function card(cx, cy, len, thk, deg) {
  const a = deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
  return rect(-len / 2, len / 2, -thk / 2, thk / 2).map(([x, y]) => [cx + x * c - y * s, cy + x * s + y * c]);
}

// ---------------------------------------------------------------------------
// reading a real slice
// ---------------------------------------------------------------------------
async function readReal(name) {
  const bytes = new Uint8Array(fs.readFileSync(path.join(ROOT, 'fixtures', '3mf', name)));
  const res = await G.readSlicedGcode3MF(bytes, { name });
  const zip = R.openZip(bytes);
  const text = new TextDecoder().decode(await zip.read('Metadata/plate_1.gcode'));
  const cfg = {};
  for (const m of text.matchAll(/^; ([a-z_]+) = (.*)$/gm)) cfg[m[1]] = m[2];
  const plate = JSON.parse(new TextDecoder().decode(await zip.read('Metadata/plate_1.json')));
  return { parsed: res.parsed, cfg, plate };
}

const OBJECT_FEATURES = new Set(['Outer wall', 'Inner wall', 'Overhang wall', 'Sparse infill',
  'Internal solid infill', 'Top surface', 'Bottom surface', 'Bridge', 'Floating vertical shell']);
const WALLS = new Set(['Outer wall', 'Inner wall', 'Overhang wall']);
const zKey = z => (Math.round(z * 1000) / 1000).toFixed(3);

/** Bambu, by printing Z: object features only, with their moves. */
function bambuByZ(parsed) {
  const out = new Map();
  for (const m of parsed.moves) {
    const k = zKey(m.z);
    if (!out.has(k)) out.set(k, { z: m.z, feat: {}, runs: {}, support: [] });
    const L = out.get(k);
    if (/^Support/.test(m.feature)) { L.support.push(m); continue; }
    if (!OBJECT_FEATURES.has(m.feature)) continue;
    (L.feat[m.feature] = L.feat[m.feature] || []).push(m);
    (L.runs[m.feature] = L.runs[m.feature] || new Set()).add(m.run);
  }
  return out;
}

/** Ours, by printing Z. */
function oursByZ(res, oi) {
  const out = new Map();
  res.objects[oi].layers.forEach(L => {
    if (!L.paths.length) return;
    const feat = {};
    L.paths.forEach(p => (feat[p.feature] = feat[p.feature] || []).push(p));
    out.set(zKey(L.printZ), { L, feat });
  });
  return out;
}

function pathLen(p) {
  const pts = p.closed ? p.pts.concat([p.pts[0]]) : p.pts;
  let s = 0;
  for (let i = 1; i < pts.length; i++) s += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  return s;
}
function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
  let t = l2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}
/** Symmetric Hausdorff (vertex-to-polyline, both ways) between Bambu moves and our paths. */
function hausdorff(moves, paths, where) {
  const segsB = moves.map(m => [m.x0, m.y0, m.x1, m.y1]);
  const segsO = [];
  paths.forEach(p => {
    const pts = p.closed ? p.pts.concat([p.pts[0]]) : p.pts;
    for (let i = 1; i < pts.length; i++) segsO.push([pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]]);
  });
  const toSet = (x, y, segs) => segs.reduce((m, s) => Math.min(m, segDist(x, y, s[0], s[1], s[2], s[3])), Infinity);
  let h = 0;
  const note = (d, x, y, side) => { if (d > h) { h = d; if (where) { where.at = [x, y]; where.side = side; } } };
  segsB.forEach(s => { note(toSet(s[0], s[1], segsO), s[0], s[1], 'bambu'); note(toSet(s[2], s[3], segsO), s[2], s[3], 'bambu'); });
  segsO.forEach(s => { note(toSet(s[0], s[1], segsB), s[0], s[1], 'ours'); note(toSet(s[2], s[3], segsB), s[2], s[3], 'ours'); });
  return h;
}

/** The auto-aim detector, loaded the way its own suites load it. */
function supportAim() {
  const ctx = { Math, Map, Set, console, Array, Object, Number, String, JSON, isFinite, Promise,
    Float32Array, Float64Array, Int32Array, Uint32Array, Uint8Array, ArrayBuffer };
  vm.createContext(ctx);
  for (const f of ['nso_thickness.js', 'nso_seat_surface.js', 'app-sculpt.js', 'app-extend.js', 'nso_support_aim.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
  }
  return ctx.NSO_SupportAim;
}

/**
 * How well a support-need region matches where Bambu put support interface:
 * recall = share of our footprint within `reach` of an interface bead,
 * precision = share of interface bead length inside our footprint grown by
 * `grow`. Sampled on a 0.1 mm grid / every 0.1 mm of bead.
 */
function coverage(footprintPolys, ifaceMoves, reach, grow) {
  let n = 0, hit = 0;
  const bb = [Infinity, Infinity, -Infinity, -Infinity];
  footprintPolys.forEach(p => p.forEach(([x, y]) => {
    bb[0] = Math.min(bb[0], x); bb[1] = Math.min(bb[1], y); bb[2] = Math.max(bb[2], x); bb[3] = Math.max(bb[3], y);
  }));
  const grid = new Map(), cell = 2;
  ifaceMoves.forEach((m, i) => {
    const x0 = Math.floor(Math.min(m.x0, m.x1) / cell), x1 = Math.floor(Math.max(m.x0, m.x1) / cell);
    const y0 = Math.floor(Math.min(m.y0, m.y1) / cell), y1 = Math.floor(Math.max(m.y0, m.y1) / cell);
    for (let a = x0; a <= x1; a++) for (let b = y0; b <= y1; b++) {
      const k = a + ',' + b; if (!grid.has(k)) grid.set(k, []); grid.get(k).push(i);
    }
  });
  const near = (x, y, r) => {
    const cx = Math.floor(x / cell), cy = Math.floor(y / cell);
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) {
      const l = grid.get((cx + a) + ',' + (cy + b)); if (!l) continue;
      for (const i of l) { const m = ifaceMoves[i]; if (segDist(x, y, m.x0, m.y0, m.x1, m.y1) <= r) return true; }
    }
    return false;
  };
  for (let x = bb[0]; x <= bb[2]; x += 0.1) for (let y = bb[1]; y <= bb[3]; y += 0.1) {
    if (!SL.inside(footprintPolys, x, y)) continue;
    n++; if (near(x, y, reach)) hit++;
  }
  let len = 0, inLen = 0;
  const grownInside = (x, y) => {
    if (SL.inside(footprintPolys, x, y)) return true;
    for (const p of footprintPolys) for (let i = 0; i < p.length; i++) {
      const q = p[(i + 1) % p.length];
      if (segDist(x, y, p[i][0], p[i][1], q[0], q[1]) <= grow) return true;
    }
    return false;
  };
  ifaceMoves.forEach(m => {
    const k = Math.max(1, Math.ceil(m.length / 0.1));
    for (let j = 0; j < k; j++) {
      const t = (j + 0.5) / k, x = m.x0 + (m.x1 - m.x0) * t, y = m.y0 + (m.y1 - m.y0) * t;
      len += m.length / k; if (grownInside(x, y)) inLen += m.length / k;
    }
  });
  return { recall: n ? hit / n : 0, precision: len ? inLen / len : 0, samples: n };
}

(async () => {
  const wasm = await SL.loadKernel({});
  const sws = await readReal('supportwithinsupport.gcode.3mf');
  const tab = await readReal('tabletop.gcode.3mf');
  const SA = supportAim();

  // =========================================================================
  section('1. The constants, re-measured off the real slice (supportwithinsupport lower block)');
  // =========================================================================
  const w = +sws.cfg.line_width, h = +sws.cfg.layer_height;
  check('line_width in the config block is 0.62 (CONSTANTS.bambuLine06.settingMm)',
        w === SL.CONSTANTS.bambuLine06.settingMm, w);
  const wallMoves = sws.parsed.moves.filter(m => WALLS.has(m.feature) && m.z < 8);
  const wRec = wallMoves.reduce((a, m) => a + m.width * m.length, 0) / wallMoves.reduce((a, m) => a + m.length, 0);
  check('wall width recovered from E is 0.609 (CONSTANTS.bambuLine06.recoveredMm)',
        Math.abs(wRec - SL.CONSTANTS.bambuLine06.recoveredMm) < 5e-4, f3(wRec));
  const fp = sws.plate.bbox_objects[0].bbox;          // [x0, y0, x1, y1], independent of the moves
  check('plate_1.json footprint is 30.000 x 30.000', Math.abs(fp[2] - fp[0] - 30) < 1e-6 && Math.abs(fp[3] - fp[1] - 30) < 1e-6,
        f3(fp[2] - fp[0]) + ' x ' + f3(fp[3] - fp[1]));
  const L5 = sws.parsed.moves.filter(m => Math.abs(m.z - 1.5) < 1e-6);
  const minX = f => Math.min(...L5.filter(m => m.feature === f).map(m => Math.min(m.x0, m.x1)));
  const minY = f => Math.min(...L5.filter(m => m.feature === f).map(m => Math.min(m.y0, m.y1)));
  const outerInset = [minX('Outer wall') - fp[0], minY('Outer wall') - fp[1]];
  check('outer wall centre sits w/2 inside the part (x and y)', outerInset.every(v => Math.abs(v - w / 2) < 2e-3),
        outerInset.map(f3).join(', ') + ' vs ' + f3(w / 2));
  const sp = SL.spacingOf(w, h);
  const wallSpacing = minX('Inner wall') - minX('Outer wall');
  check('outer -> inner wall spacing is w - h(1 - pi/4)', Math.abs(wallSpacing - sp) < 2e-3, f3(wallSpacing) + ' vs ' + f3(sp));
  const infInset = minX('Sparse infill') - minX('Inner wall');
  check('infill boundary sits 0.85 x spacing inside the inner wall (infill_wall_overlap 15 %)',
        Math.abs(infInset - 0.85 * sp) < 2e-3, f3(infInset) + ' vs ' + f3(0.85 * sp));
  const diag = L5.filter(m => m.feature === 'Sparse infill' && m.length > 3 &&
    Math.abs(Math.abs(Math.cos(m.angle - Math.PI / 4)) - 1) < 1e-3);
  const us = [...new Set(diag.map(m => (Math.round((m.y0 - m.x0) / Math.SQRT2 * 1000) / 1000)))].sort((a, b) => a - b);
  const gaps = us.slice(1).map((u, i) => u - us[i]).filter(d => d > 1);
  const gridSp = Math.min(...gaps);
  check('sparse grid: one family\'s line spacing is 2 x spacing / density', Math.abs(gridSp - 2 * sp / 0.15) < 0.01,
        f3(gridSp) + ' vs ' + f3(2 * sp / 0.15));
  check('sparse grid: two families per layer, at 45 and 135 deg', (() => {
    const angs = new Set(L5.filter(m => m.feature === 'Sparse infill' && m.length > 3)
      .map(m => ((Math.round(m.angle * 180 / Math.PI) % 180) + 180) % 180));
    return angs.has(45) && angs.has(135);
  })());

  // =========================================================================
  section('2. supportwithinsupport - reconstructed, sliced with Bambu\'s own settings');
  // =========================================================================
  const inset = w / 2;
  const up = { x0: 76.613 - inset, x1: 95.993 + inset, y0: 81.307 - inset, y1: 100.687 + inset };
  check('upper box reconstructs to 20.000 x 20.000', Math.abs(up.x1 - up.x0 - 20) < 2e-3 && Math.abs(up.y1 - up.y0 - 20) < 2e-3,
        f3(up.x1 - up.x0) + ' x ' + f3(up.y1 - up.y0));
  const ribs = [];
  for (let k = 0; k < 13; k++) ribs.push(...prism(rect(73.973 + 2 * k - inset, 74.228 + 2 * k + inset, 78.028 - inset, 103.408 + inset), 8.1, 8.4));
  const swsSoup = [].concat(
    prism(rect(fp[0], fp[2], fp[1], fp[3]), 0, 8.1),             // lower block: plate_1.json footprint, top at the Top surface layer
    ribs,                                                         // 13 ribs, one layer, z 8.1 - 8.4
    prism(rect(up.x0, up.x1, up.y0, up.y1), 9.3, 15.3));          // upper box: underside 0.2 over the interface top (9.1)
  const bOpts = SL.defaultsFor(0.6, { layerMm: 0.3, firstLayerMm: 0.3, outerWallWidthMm: w, innerWallWidthMm: w,
    infillWidthMm: w, dropToPlate: false });
  const rS = SL.sliceObjects([{ name: 'nest_2pcs', soup: swsSoup }], bOpts, wasm);
  check('sliced', rS.ok, rS.reason);
  console.log('  ' + rS.report.split('\n').join('\n  '));
  compareLayers('supportwithinsupport', sws.parsed, rS, 0, {
    // Bambu features ours never makes, and why (docs/SLICER.md section 5)
    skipFeature: { 'Floating vertical shell': 'ensure_vertical_shell_thickness - not built' }
  });

  // --- overhang / support need
  const ovS = rS.objects[0].overhang;
  console.log('  support-need regions: ' + ovS.map(r => 'z ' + f3(r.firstZ) + ' layers ' + (r.firstLayer + 1) + '-' + (r.lastLayer + 1) +
    ' footprint ' + r.footprintMm2.toFixed(1) + ' mm^2 on ' + r.standsOn).join('; '));
  const upperReg = ovS.find(r => Math.abs(r.firstZ - 9.3) < 1e-6);
  check('the upper box\'s underside (z 9.3) needs support', !!upperReg);
  check('... and that support stands on the model, not the plate (Bambu: support_on_build_plate_only = 0, interface printed on the block)',
        upperReg && upperReg.standsOn === 'model', upperReg && upperReg.standsOn);
  check('no other support-need region (Bambu printed support only under the upper box)', ovS.length === 1, ovS.length);
  // Bambu's interface here is not a full sheet: at z 9.1 it is y-direction
  // lines at a 1.056 mm pitch, about half populated, and it reaches past the
  // box (support expansion). So: its bounding box must contain our footprint,
  // and recall is read at one measured pitch; precision is not a fair test.
  const ifaceS = sws.parsed.moves.filter(m => m.feature === 'Support interface');
  const bbI = [Math.min(...ifaceS.flatMap(m => [m.x0, m.x1])), Math.min(...ifaceS.flatMap(m => [m.y0, m.y1])),
               Math.max(...ifaceS.flatMap(m => [m.x0, m.x1])), Math.max(...ifaceS.flatMap(m => [m.y0, m.y1]))];
  const grow = [upperReg.min[0] - bbI[0], upperReg.min[1] - bbI[1], bbI[2] - upperReg.max[0], bbI[3] - upperReg.max[1]];
  check('Bambu\'s interface (z 8.9 - 9.1) covers our support-need footprint: its bounding box contains ours',
        grow.every(v => v >= -0.05), 'Bambu reaches past ours by ' + grow.map(f3).join(' / ') + ' mm (x-, y-, x+, y+)');
  const covS = coverage(upperReg.footprintPolys, ifaceS.filter(m => m.z > 9), 1.1, 0.62);
  console.log('  vs Bambu\'s top interface layer (z 9.1): ' + (covS.recall * 100).toFixed(1) + ' % of our footprint within one ' +
    'pitch (1.1 mm) of an interface bead - Bambu\'s layer is about half populated there');
  // --- and the auto-aim detector on the same mesh (Task 5: corroborate or challenge)
  for (const ang of [30, 45]) {
    const d = SA.detectOverhangs(Float32Array.from(swsSoup), { skipList: [], angleDeg: ang });
    const flagged = d.regions.filter(r => r.max[2] > 9.2 && r.min[2] < 9.4);
    console.log('  NSO_SupportAim.detectOverhangs at ' + ang + ' deg: ' + d.regions.length + ' region(s); triangles self-supported ' +
      d.trisSelfSupported + ', flagged ' + d.trisFlagged);
    check('detectOverhangs does NOT flag the upper box underside at ' + ang + ' deg (its ray hits the block below)', flagged.length === 0,
          d.trisSelfSupported + ' self-supported');
  }
  finding('supportwithinsupport: the slicer CORROBORATES Bambu and CHALLENGES detectOverhangs. Bambu printed support ' +
    'interface under the upper box (on the block below); the layer comparison calls the same region, inside Bambu\'s ' +
    'interface footprint (which reaches ' + grow.map(v => v.toFixed(1)).join('/') + ' mm further: support expansion, not built here). detectOverhangs reports it ' +
    '"self-supported" at 30 and 45 deg because its downward ray meets the block 0.9 mm below - by design (auto-aim ' +
    'only builds plate-standing struts), but it means detectOverhangs is not a support-NEED detector for anything over the piece itself.');

  // =========================================================================
  section('3. tabletop - reconstructed, sliced with Bambu\'s own settings');
  // =========================================================================
  const legs = [[115.58, 117.096], [115.58, 67.096], [65.58, 67.096], [65.58, 117.096]];
  const tabSoup = [];
  legs.forEach(([cx, cy]) => { tabSoup.push(...prism(card(cx, cy, 14, 1, 45), 0, 20.1)); tabSoup.push(...prism(card(cx, cy, 14, 1, 135), 0, 20.1)); });
  const slab = { x0: 55.890 - inset, x1: 125.270 + inset, y0: 57.406 - inset, y1: 126.786 + inset };
  check('slab reconstructs to 70.000 x 70.000', Math.abs(slab.x1 - slab.x0 - 70) < 2e-3 && Math.abs(slab.y1 - slab.y0 - 70) < 2e-3,
        f3(slab.x1 - slab.x0) + ' x ' + f3(slab.y1 - slab.y0));
  tabSoup.push(...prism(rect(slab.x0, slab.x1, slab.y0, slab.y1), 20.1, 21.9));
  const rT = SL.sliceObjects([{ name: 'house_of_cards', soup: tabSoup }], bOpts, wasm);
  check('sliced', rT.ok, rT.reason);
  console.log('  ' + rT.report.split('\n').join('\n  '));
  compareLayers('tabletop', tab.parsed, rT, 0, { skipFeature: {} });
  finding('shells above a bridge, in BOTH real files: Bambu thins the third layer over a bridge (supportwithinsupport z 10.2: ' +
    'solid centre, sparse ring by the walls; tabletop z 21.0: sparse over the legs only) and keeps the first two fully solid ' +
    '(tabletop z 20.4 / 20.7 over the leg arms). The in-house rule counts plain layers (bottom_shell_layers = 3 below, top 3 above), ' +
    'so it leaves the leg arms sparse on 20.4 / 20.7 and the whole third layer solid on 10.2. A black-box hypothesis consistent ' +
    'with both - bridge shells anchored ~1 mm into the supported area and shrinking layer by layer - is recorded in docs/SLICER.md, ' +
    'NOT built: two data points do not pin it.');
  const ovT = rT.objects[0].overhang;
  console.log('  support-need regions: ' + ovT.map(r => 'z ' + f3(r.firstZ) + ' layers ' + (r.firstLayer + 1) + '-' + (r.lastLayer + 1) +
    ' footprint ' + r.footprintMm2.toFixed(1) + ' mm^2 on ' + r.standsOn).join('; '));
  const slabReg = ovT.find(r => Math.abs(r.firstZ - 20.1) < 1e-6);
  check('the slab\'s underside (z 20.1) needs support', !!slabReg);
  check('... standing on the plate (Bambu: support_on_build_plate_only = 1, and it built a tree from the plate)',
        slabReg && slabReg.standsOn === 'plate', slabReg && slabReg.standsOn);
  check('no other support-need region', ovT.length === 1, ovT.length);
  const ifaceT = tab.parsed.moves.filter(m => m.feature === 'Support interface' && Math.abs(m.z - 19.8) < 1e-6);
  const covT = coverage(slabReg.footprintPolys, ifaceT, 1.09, 0.62);
  console.log('  vs Bambu\'s top interface layer (z 19.8, 1.09 mm pitch): ' + (covT.recall * 100).toFixed(1) + ' % of our footprint within one pitch of an interface bead, ' +
    (covT.precision * 100).toFixed(1) + ' % of interface bead length inside our footprint (+0.62)');
  check('our footprint is where Bambu put interface (recall >= 95 %)', covT.recall >= 0.95, (covT.recall * 100).toFixed(1) + ' %');
  check('Bambu put interface where we need support (precision >= 95 %)', covT.precision >= 0.95, (covT.precision * 100).toFixed(1) + ' %');
  for (const ang of [30, 45]) {
    const d = SA.detectOverhangs(Float32Array.from(tabSoup), { skipList: [], angleDeg: ang });
    const big = d.regions.filter(r => r.max[2] > 20 && r.min[2] < 20.2);
    const area = big.reduce((a, r) => a + r.areaMm2, 0);
    check('detectOverhangs agrees at ' + ang + ' deg: the slab underside is flagged', big.length >= 1,
          big.length + ' region(s), ' + area.toFixed(1) + ' mm^2 vs our footprint ' + slabReg.footprintMm2.toFixed(1));
  }

  // =========================================================================
  section('4. The tape strut / tree artifact - Bambu\'s reported overlap at layer 91');
  // =========================================================================
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nso_slicer_'));
  const art = {};
  for (const [key, flags] of [['pre', ['--hollow', '--tree']], ['iface', ['--interface', '--tree']]]) {
    const out = path.join(tmp, key + '.3mf');
    execFileSync(process.execPath, [path.join(ROOT, 'tools', 'nso_support_slice_artifact.js'), ...flags, out],
      { stdio: 'ignore', maxBuffer: 64 * 1024 * 1024 });
    const pr = await R.parse3MF(new Uint8Array(fs.readFileSync(out)), { name: key });
    art[key] = pr.objects.map(o => ({ name: o.name, soup: o.positions }));
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  const aOpts = SL.defaultsFor(0.4, { layerMm: 0.2, firstLayerMm: 0.2, dropToPlate: false, emitGcode: false });
  const rPre = SL.sliceObjects(art.pre, aOpts, wasm);
  const rIf = SL.sliceObjects(art.iface, aOpts, wasm);
  console.log('  pre-interface (--hollow --tree), as Bambu was given it:\n    ' + rPre.report.split('\n').join('\n    '));
  const big = rPre.conflicts.slice().sort((a, b) => b.areaMm2 - a.areaMm2)[0];
  check('the in-house slice finds the tree and the piece overlapping at layer 91 (Bambu\'s report)',
        rPre.conflicts.some(c => c.layer === 91 && /tree/.test(c.b)), rPre.conflicts.map(c => c.layer + ':' + c.areaMm2.toFixed(2)).join(' '));
  check('layer 91 is the largest overlap', big && big.layer === 91, big && big.layer + ' (' + big.areaMm2.toFixed(2) + ' mm^2)');
  check('the straight strut does not overlap the piece anywhere', !rPre.conflicts.some(c => /underside/.test(c.a + c.b)));
  const extra = rPre.conflicts.filter(c => c.layer !== 91).map(c => c.layer + ' (' + c.areaMm2.toFixed(2) + ' mm^2)');
  if (extra.length) {
    finding('tape pre-interface: the in-house slice ALSO reports overlap at layer(s) ' + extra.join(', ') + '. Layers 87-88 are ' +
      'sub-0.1 mm^2 grazes of a tree tip on the side wall (the 0.26 mm reach commit e50eaea measured); layer 92 is the ' +
      'same tip as 91. The relayed Bambu message named layer 91 only - whether Bambu lists every layer is not on record, ' +
      'so these are neither confirmed nor contradicted.');
  }
  console.log('  after the interface (--interface --tree):\n    ' + rIf.report.split('\n').join('\n    '));
  check('with the 0.18 mm gap and interface, no layer has any overlap', rIf.conflicts.length === 0, rIf.conflicts.length);
  const lastLayer = oi => { let l = -1; rIf.objects[oi].layers.forEach((L, i) => { if (L.areaMm2 > 0) l = i; }); return l + 1; };
  const pieceFirstUnder = rIf.objects[0].layers.findIndex((L, i) => i > 80 && L.areaMm2 > 1000) + 1;
  check('both supports end at layer 89 (the interface fills 88-89)', lastLayer(1) === 89 && lastLayer(2) === 89, lastLayer(1) + ', ' + lastLayer(2));
  check('layer 90 is empty of support; the underside starts printing at layer 91 (the gap: CONSTANTS.supportGap, 0.182 mm < one 0.2 layer)',
        rIf.objects[1].layers[89].areaMm2 === 0 && rIf.objects[2].layers[89].areaMm2 === 0 && pieceFirstUnder === 91,
        'piece from ' + pieceFirstUnder);
  // The tree stands on ONE foot pad (supports-print-1): its two trunks stand
  // within 6 mm, so they share a pad - their footprints grown by 4 mm, kept
  // 0.2 mm off the piece (it was two discs of r = 3 mm, 2 x 28.19 mm^2). One
  // outline and no hole in it; above it the section is the two trunks alone.
  const footL = rIf.objects[2].layers[0], trunkL = rIf.objects[2].layers[1];
  check('the tree stands on one shared foot: layer 1 is one whole pad, 178.77 mm^2, its one outline an outer one (no ring)',
        footL.sectionPolys.length === 1 && footL.sectionPolys.every(p => SL.signedArea(p) > 0) && Math.abs(footL.areaMm2 - 178.766) < 0.01,
        footL.sectionPolys.length + ' outline(s), ' + footL.areaMm2.toFixed(3) + ' mm^2');
  check('... walled, and layer 2 is the trunks alone (8.640 mm^2)', footL.wallCount >= 1 && Math.abs(trunkL.areaMm2 - 8.64) < 0.01,
        footL.wallCount + ' wall(s); layer 2 ' + trunkL.areaMm2.toFixed(3) + ' mm^2');
  // interface strands, read off the sliced interface layers: the section is
  // cut across the strands at its middle and the cut's intervals are the
  // strands (nso_crosshatch joins a layer's lines with an end bar, so the
  // layer is one polygon and a bounding box would read it as a blob).
  const strands = {};
  for (const li of [87, 88]) {
    const polys = rIf.objects[1].layers[li].sectionPolys;
    const xs = polys.flat().map(q => q[0]), ys = polys.flat().map(q => q[1]);
    const alongX = (Math.max(...xs) - Math.min(...xs)) >= (Math.max(...ys) - Math.min(...ys));
    const mid = alongX ? (Math.min(...xs) + Math.max(...xs)) / 2 : (Math.min(...ys) + Math.max(...ys)) / 2;
    // one scan line through `mid`, perpendicular to the strands
    const ang = alongX ? Math.PI / 2 : 0;
    const cuts = SL.scanFill(polys, ang, 1e3, alongX ? -mid : mid)
      .map(sg => ({ w: Math.hypot(sg.b[0] - sg.a[0], sg.b[1] - sg.a[1]), c: alongX ? (sg.a[1] + sg.b[1]) / 2 : (sg.a[0] + sg.b[0]) / 2 }))
      .sort((a, b) => a.c - b.c);
    strands[li + 1] = { alongX, cuts };
  }
  console.log('  strut interface strands, cut across from the slice: ' + Object.keys(strands).map(k => 'layer ' + k + ' along ' +
    (strands[k].alongX ? 'x' : 'y') + ': ' + strands[k].cuts.map(c => f3(c.w) + ' wide at ' + f3(c.c)).join(', ')).join('; '));
  const nsoI = SL.CONSTANTS.interfaceStrand.nso;
  const all = Object.values(strands).flatMap(v => v.cuts);
  check('two strands per interface layer, 0.42 mm wide (CONSTANTS.interfaceStrand.nso)',
        Object.values(strands).every(v => v.cuts.length === 2) && all.every(c => Math.abs(c.w - nsoI.widthMm) < 0.01), all.map(c => f3(c.w)).join(' '));
  check('strand pitch 1.2 mm on both layers', Object.values(strands).every(v => v.cuts.length === 2 && Math.abs(v.cuts[1].c - v.cuts[0].c - nsoI.pitchMm) < 0.01),
        Object.values(strands).map(v => v.cuts.length === 2 ? f3(v.cuts[1].c - v.cuts[0].c) : '-').join(' '));
  check('the two layers run at 90 deg to each other', strands[88].alongX !== strands[89].alongX);
  finding('interface strands: NSO builds 0.42 mm at 1.2 mm pitch; Bambu\'s own interface in tabletop measures 0.61 mm at 1.09 mm ' +
    '(CONSTANTS.interfaceStrand) - the same two-layer, one-direction-per-layer construction at Bambu\'s 0.6 nozzle widths.');

  // --- the taper law, read back off the slice of the round strut. Since the
  // grid-pack planner (#175) the tree is square members merged pairwise, with
  // no taper; the strut is the one support still built to the law (the
  // artifact's own "section round, ... 2 + 2 tan 5 deg x height below the
  // tip" line), and it ends on the same contacts' z.
  const tree = rIf.objects[2];
  const strut = rIf.objects[1];
  const ST_TIP = 2, ST_ANG = 5 * Math.PI / 180;
  const tipZ = 18.042;                     // plate z of every contact on this piece (docs/SUPPORT-TREE.md 6c)
  // The strut is one tube from the plate to its tip: one outline, at most one
  // bore, and a diameter that only ever shrinks going up.
  const rows = [];
  for (const L of strut.layers) {
    if (!(L.areaMm2 > 0)) continue;
    if (!(L.printZ < 17.4)) break;          // 88-89 are the interface's crosshatch on this build, not tube
    const outers = L.sectionPolys.filter(p => SL.signedArea(p) > 0);
    const holes = L.sectionPolys.length - outers.length;
    if (outers.length !== 1 || holes > 1) break;
    const z = L.printZ - L.h / 2;
    const eqD = Math.sqrt(4 * SL.signedArea(outers[0]) / Math.PI);
    if (rows.length && eqD > rows[rows.length - 1].eqD) break;
    rows.push({ z, eqD, law: ST_TIP + 2 * Math.tan(ST_ANG) * (tipZ - z) });
  }
  const worst = rows.reduce((m, r) => Math.max(m, Math.abs(r.eqD - r.law)), 0);
  check('the strut\'s sliced diameter IS the measured taper law d = 2 + 2 tan 5 deg x depth (24-gon of equal area, <= 0.005 mm)',
        rows.length >= 20 && worst <= 0.005, rows.length + ' layers z ' + f3(rows[0].z) + '..' + f3(rows[rows.length - 1].z) + ', worst ' + worst.toFixed(4) + ' mm');
  // and at the top: the pre-interface strut, whose tip runs to its contact, on
  // layer 89 (slice z 17.7) - the last layer below the tip. (On the
  // interface build layers 88-89 are crosshatch, not tube.)
  const tipL = rPre.objects[1].layers[88];
  const tipD = Math.min(...tipL.sectionPolys.filter(p => SL.signedArea(p) > 0).map(p => Math.sqrt(4 * SL.signedArea(p) / Math.PI)));
  const tipLaw = ST_TIP + 2 * Math.tan(ST_ANG) * (tipZ - (tipL.printZ - tipL.h / 2));
  check('the strut\'s tip on layer 89 is the law\'s own diameter there (1 %)',
        Math.abs(tipD - tipLaw) / tipLaw < 0.01, f3(tipD) + ' vs ' + f3(tipLaw) + ' at z ' + f3(tipL.printZ));
  // One wall per layer is a bored tube's property: the strut is one, end to
  // end. The grid-pack tree leaves members too small to bore SOLID (the
  // artifact says which), so its layers are not all tube.
  const treeWalls = strut.layers.filter(L => L.areaMm2 > 0 && L.printZ > 1 && L.printZ < 17.4).map(L => L.wallCount);
  const oneWall = treeWalls.filter(c => c === 1).length;
  check('every strut tube layer slices to ONE wall (Bambu\'s own trees: one line, CONSTANTS.treeWall)', oneWall === treeWalls.length,
        oneWall + ' of ' + treeWalls.length);
  // the same artifact at the real 0.6 nozzle
  const r06 = SL.sliceObjects(art.iface, SL.defaultsFor(0.6, { layerMm: 0.2, firstLayerMm: 0.2, dropToPlate: false, emitGcode: false }), wasm);
  const t06 = r06.objects[2].layers.filter(L => L.areaMm2 > 0 && L.printZ > 1 && L.printZ < 17.4);
  const lost = t06.filter(L => L.wallCount === 0).length;
  finding('the tape artifact\'s tree is bored at a 0.42 mm wall (floorFor(0.4)). Sliced with the 0.6 nozzle\'s 0.63 mm line, ' + lost + ' of ' +
    t06.length + ' tube layers get NO wall at all (the tube wall is thinner than one line; Bambu\'s detect_thin_wall = 0 drops such ' +
    'regions the same way). In-house prediction, not yet seen in a real 0.6 slice: build the tree at hollowWallMm = 0.63 for the 0.6 nozzle.');
  check('... pinned: at 0.63 mm lines the 0.42 mm tube walls vanish on most tube layers', lost > t06.length / 2, lost + ' of ' + t06.length);

  // =========================================================================
  section('5. The coupon export - the sheet as Bambu Studio prints it (classic walls, Detect thin wall)');
  // =========================================================================
  {
    const PX = require('./nso_supports_print_export.js');
    const AU = require('./nso_slicer_audit.js');
    const piece = readSTL(path.join(ROOT, 'fixtures', 'supports', 'top_clip_x2_coupon.stl'));
    const plen = p => { const q = p.closed ? p.pts.concat([p.pts[0]]) : p.pts; let l = 0; for (let i = 0; i + 1 < q.length; i++) l += Math.hypot(q[i + 1][0] - q[i][0], q[i + 1][1] - q[i][1]); return l; };
    /* the export, sliced as G-scope slices it: the piece a part, each support a support (thin walls on, as its
       detect_thin_wall = 1 says); the sheet layers' thin passes, and the audit tool's reading of the G-code */
    const sliceExport = async over => {
      const b = await PX.build(piece, over);
      const objs = b.objects.map((o, i) => i === 0 ? { name: o.name, soup: o.soup, key: 1, role: 'part' } : { name: o.name, soup: o.soup, role: 'support', hostKey: 1 });
      const r = SL.sliceObjects(objs, SL.defaultsFor(0.4, { layerMm: 0.2, firstLayerMm: 0.2 }), wasm);
      const names = {}; b.objects.forEach((o, i) => { names[i] = o.name; });
      const boxes = AU.exportSheetBoxes(b.objects.map(o => ({ name: o.name, soup: o.soup })));
      const au = AU.sheetAudit(r.gcode, { names, boxes, shift: [0, 0] });
      const sheetLayers = [];
      r.objects.forEach(ob => ob.role === 'support' && ob.layers.forEach(L => {
        const th = L.paths.filter(p => p.thinWall);
        if (th.length && L.paths.some(p => /Support (interface|transition)/.test(p.feature)))
          sheetLayers.push({ z: L.printZ, paths: th.length, mm: th.reduce((a, p) => a + plen(p), 0), moves: th.reduce((a, p) => a + p.pts.length - 1 + (p.closed ? 1 : 0), 0),
                             feats: [...new Set(th.map(p => p.feature))] });
      }));
      return { b, r, au, sheetLayers };
    };
    const s40 = await sliceExport({}), s43 = await sliceExport({ sheetWidthMm: 0.43 });
    const w40 = s40.b.areas[0].tp.sheet.widthMm, w43 = s43.b.areas[0].tp.sheet.widthMm;
    const show = S => S.sheetLayers.map(l => 'z ' + l.z.toFixed(2) + ': ' + l.paths + ' path(s), ' + l.mm.toFixed(1) + ' mm in ' + l.moves + ' moves').join(' | ');
    console.log('  NSO\'s slice of the ' + f3(w40) + ' export, sheet layers: ' + show(s40));
    check('the card\'s export (' + f3(w40) + ' lines): 8 sheet layers (slab and leg, 4 each), every one ONE thin-wall path, Support transition then interface',
          w40 === 0.4 && s40.sheetLayers.length === 8 && s40.sheetLayers.every(l => l.paths === 1) &&
          s40.sheetLayers.filter(l => /interface/.test(l.feats[0])).length === 4, s40.sheetLayers.map(l => l.feats.join('+')).join(', '));
    /* the record: the slab's sheet layer in Bambu Studio, one run of 54 extrusions, ~434 mm (PR #256's reading of
       the owner's thinwall plate; Bambu draws the loop, then the serpentine joined to it, no travel between) */
    const slab = s40.sheetLayers.filter(l => l.mm > 200);
    check('the slab\'s 4 layers: ONE path each within 10 % of Bambu\'s 434 mm, and the T / I2 layers within 10 % of its 54 extrusions (the record)',
          slab.length === 4 && slab.every(l => Math.abs(l.mm / 434 - 1) <= 0.10) && slab.filter(l => l.moves > 40).every(l => Math.abs(l.moves / 54 - 1) <= 0.10),
          slab.map(l => l.mm.toFixed(1) + ' mm / ' + l.moves + ' moves').join(', ') + ' (I1 runs its 16 lines the long way: ' + (slab.find(l => l.moves <= 40) || {}).moves + ' moves)');
    check('the ' + f3(w43) + ' export slices to the same path count, layer for layer (one pass, not an outline)',
          w43 === 0.43 && s43.sheetLayers.length === s40.sheetLayers.length && s43.sheetLayers.every((l, i) => l.paths === s40.sheetLayers[i].paths &&
            Math.abs(l.mm / s40.sheetLayers[i].mm - 1) < 0.02), show(s43));
    /* read back by the audit tool, as it reads Bambu's G-code */
    const L40 = s40.au.layers;
    console.log('  the audit tool on NSO\'s G-code: ' + L40.map(l => 'z ' + l.z.toFixed(2) + ' ' + l.chains + ' run(s), ' + l.toolpathMm.toFixed(0) + ' mm on its lines, ' +
      l.passes.toFixed(2) + ' passes, E/mm ' + l.eMm.toFixed(4) + ' = ' + l.ratio.toFixed(2) + ' x outer wall, ' + l.printed + '/' + l.exportLines + ' lines').join(' | '));
    /* passes: the toolpath on the lines over their length - a turn's ends where it meets its lines count too, so
       one pass reads a little over 1; a line drawn twice (out and back round a sliver) reads 2 */
    check('...the audit tool reads it as Bambu\'s thin-wall print: every line printed, once (passes 1.00 - 1.10), at the outer wall\'s E/mm (+- 15 %)',
          L40.length === 8 && L40.every(l => l.printed === l.exportLines && l.passes >= 1 && l.passes <= 1.10 && Math.abs(l.lineRatio - 1) <= 0.15),
          'outer wall ' + s40.au.outerWallEmm.toFixed(4) + ' E/mm (Bambu measured 0.0307)');
    /* the owner's Bambu G-code of this export, when it is in the repo */
    const BG = path.join(ROOT, 'fixtures', 'supports', 'top_clip_x2_supports.gcode.3mf');
    if (!fs.existsSync(BG)) {      /* the file is in the repo; kept so a checkout without it still runs */
      finding('the coupon export against Bambu\'s own slice of it: NOT RUN - fixtures/supports/top_clip_x2_supports.gcode.3mf is not in the repo. ' +
        'Slice tools/supports-print-out/top_clip_x2_supports.3mf in Bambu Studio (open as a project; classic walls, Detect thin wall), save the ' +
        '.gcode.3mf there, and this section compares path count and total mm per sheet layer within 10 %.');
    } else {
      const zip = R.openZip(new Uint8Array(fs.readFileSync(BG)));
      const dec = new TextDecoder();
      const plate = zip.names().find(n => /plate_\d+\.gcode$/.test(n));
      const gcode = dec.decode(await zip.read(plate));
      const info = zip.names().includes('Metadata/slice_info.config') ? dec.decode(await zip.read('Metadata/slice_info.config')) : '';
      const bnames = AU.sliceNames(info);
      const boxes = AU.exportSheetBoxes(s40.b.objects.map(o => ({ name: o.name, soup: o.soup })));
      const reg = AU.registerShift(AU.extrusions(gcode), bnames, boxes);
      const bau = AU.sheetAudit(gcode, { names: bnames, boxes, shift: reg ? reg.shift : [0, 0] });
      const pairs = L40.map(l => ({ n: l, b: bau.layers.find(x => Math.abs(x.z - l.z) < 0.05) }));
      const row = l => l.drawings + ' drawing(s) in ' + l.runs + ' run(s), ' + l.runMm.toFixed(1) + ' mm (' + l.toolpathMm.toFixed(0) + ' on its lines), ' + l.printed + '/' + l.exportLines + ' lines';
      console.log('  Bambu\'s slice of it (' + path.basename(BG) + ', registered ' + (reg ? reg.shift.join(', ') + ' mm, ' + Math.round(100 * reg.share) + ' %' : 'not') + '):\n    ' +
        pairs.map(p => 'z ' + p.n.z.toFixed(2) + ': NSO ' + row(p.n) + ' | Bambu ' + (p.b ? row(p.b) : 'no layer')).join('\n    '));
      /* a path is a connected drawing: Bambu draws each layer's one wall in two runs - from a seam mid-serpentine
         both ways on the slab, the loop and then the serpentine ending on it on the leg - NSO in one */
      check('Bambu\'s own slice of this export (breakawayV1, the owner\'s breakaway print): every sheet layer one connected drawing in both, every line printed in both, total mm within 10 %',
            pairs.length === 8 && pairs.every(p => p.b && p.n.drawings === 1 && p.b.drawings === 1 && p.n.printed === p.n.exportLines && p.b.printed === p.b.exportLines &&
              Math.abs(p.n.runMm / p.b.runMm - 1) <= 0.10),
            pairs.map(p => 'z ' + p.n.z.toFixed(2) + ' ' + (p.b ? (100 * (p.n.runMm / p.b.runMm - 1)).toFixed(1) + ' %' : '-')).join(', '));
      finding('runs: Bambu draws every sheet layer of the coupon export in 2 runs of extrusion (slab: from a seam at the foot of a ' +
        'serpentine line, one way to its free end, travel back, then the other way through the bridge and round the loop - its 54 extrusions ' +
        'and 3 travels; leg: the loop closed, then the serpentine as a run of its own ending on it). NSO draws each in ONE run (the loop, then ' +
        'the serpentine). One connected wall in both; ' + pairs.map(p => p.b ? p.b.runs : '-').join('/') + ' runs against ' + pairs.map(p => p.n.runs).join('/') + '.');
    }
  }

  // =========================================================================
  console.log('\n' + pass + ' passed, ' + fail + ' failed; ' + findings.length + ' finding(s) recorded');
  process.exit(fail ? 1 : 0);

  // -------------------------------------------------------------------------
  function compareLayers(label, parsed, res, oi, opts) {
    const B = bambuByZ(parsed), O = oursByZ(res, oi);
    const zs = [...new Set([...B.keys()].filter(k => Object.keys(B.get(k).feat).length).concat([...O.keys()]))]
      .sort((a, b) => +a - +b);
    let same = 0, wallSame = 0, n = 0, outerH = 0, innerH = 0, outerAt = '';
    const diffs = [];
    let lenB = { solid: 0, sparse: 0 }, lenO = { solid: 0, sparse: 0 };
    const SOLID = new Set(['Internal solid infill', 'Top surface', 'Bottom surface', 'Bridge']);
    zs.forEach(k => {
      const b = B.get(k), o = O.get(k);
      const fb = new Set(Object.keys(b ? b.feat : {}).filter(f => !opts.skipFeature[f]));
      const fo = new Set(Object.keys(o ? o.feat : {}));
      n++;
      const eq = fb.size === fo.size && [...fb].every(f => fo.has(f));
      if (eq) same++; else diffs.push('z ' + k + ': Bambu {' + [...fb].join(', ') + '} vs ours {' + [...fo].join(', ') + '}');
      const wb = b ? [...WALLS].reduce((a, f) => a + (b.runs[f] ? b.runs[f].size : 0), 0) : 0;
      const wo = o ? o.L.wallLoopsByDepth.reduce((a, c) => a + c, 0) : 0;
      if (wb === wo) wallSame++;
      if (b && o && b.feat['Outer wall'] && o.feat['Outer wall']) {
        const wh = {}; const hh = hausdorff(b.feat['Outer wall'], o.feat['Outer wall'], wh);
        if (hh > outerH) { outerH = hh; outerAt = 'z ' + k + ' at ' + wh.at.map(f3).join(',') + ' (' + wh.side + ' vertex)'; }
      }
      if (b && o && b.feat['Inner wall'] && o.feat['Inner wall']) innerH = Math.max(innerH, hausdorff(b.feat['Inner wall'], o.feat['Inner wall']));
      if (b) Object.keys(b.feat).forEach(f => { const l = b.feat[f].reduce((a, m) => a + m.length, 0); if (SOLID.has(f)) lenB.solid += l; if (f === 'Sparse infill') lenB.sparse += l; });
      if (o) Object.keys(o.feat).forEach(f => { const l = o.feat[f].reduce((a, p) => a + pathLen(p), 0); if (SOLID.has(f)) lenO.solid += l; if (f === 'Sparse infill') lenO.sparse += l; });
    });
    console.log('  ' + label + ': ' + n + ' object layers; same feature set on ' + same + ', same wall-loop count on ' + wallSame);
    diffs.forEach(d => console.log('    differs ' + d));
    check(label + ': same object layer heights (every printing Z Bambu has, we have)',
      [...B.keys()].filter(k => Object.keys(B.get(k).feat).length).every(k => O.has(k)));
    check(label + ': same wall-loop count on every object layer', wallSame === n, wallSame + ' of ' + n);
    // Tolerance: Bambu's own `resolution` (0.012 mm, both config blocks - it
    // simplifies its polygons that far: the tabletop's leg-tip corner moves
    // 0.0106 mm between layers of one prism) plus its 3-decimal G-code.
    check(label + ': outer walls lie on Bambu\'s (Hausdorff <= 0.013 mm; consistency only - the inset was used to reconstruct)',
      outerH <= 0.013, f3(outerH) + ' mm, worst ' + outerAt);
    check(label + ': inner walls lie on Bambu\'s (Hausdorff <= 0.013 mm; independent)', innerH <= 0.013, f3(innerH) + ' mm');
    check(label + ': same feature set on >= 85 % of object layers', same / n >= 0.85, same + ' of ' + n);
    const rs = lenO.solid / lenB.solid, rp = lenB.sparse ? lenO.sparse / lenB.sparse : 1;
    console.log('  extrusion length, ours / Bambu: solid ' + rs.toFixed(3) + ', sparse ' + rp.toFixed(3));
    check(label + ': solid infill length within 10 % of Bambu\'s', Math.abs(rs - 1) <= 0.10, rs.toFixed(3));
    if (lenB.sparse > 100) check(label + ': sparse infill length within 25 % of Bambu\'s', Math.abs(rp - 1) <= 0.25, rp.toFixed(3));
    if (diffs.length) finding(label + ': ' + diffs.length + ' of ' + n + ' object layers differ in feature set (listed above)');
    return { same, n, diffs };
  }
})().catch(err => { console.error(err); process.exit(1); });
