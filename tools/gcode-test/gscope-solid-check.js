#!/usr/bin/env node
/*
 * G-scope "Export as solid" - the headless half. No browser.
 *
 *  1. RUNS. The parser's `run` numbering breaks on exactly the things that
 *     stop a bead (travel, wipe, retraction, Z move, G92 reposition) and on
 *     nothing else (F-only lines, M-codes, FEATURE tags, E-only primes, G92 E,
 *     an arc's chords). A synthetic file with one of each.
 *  2. CHAINS. `chainsOf` caps where a run starts, where a selection skips a
 *     move, and nowhere else.
 *  3. THE CLOSED SWEEP. `NSO_PathSweep.sweepClosed` on a square loop: no caps,
 *     closed, 2-manifold, volume = section x centreline exactly; a twisted
 *     space loop is refused by name.
 *  4. REAL SLICES. Both committed `.gcode.3mf` files, every move: every shell
 *     closed, 2-manifold, consistently wound, positive; solid volume equals the
 *     toolpath view's volume plus the counted seam closures; every forced split
 *     is a named sweep refusal.
 *  5. CANONICAL CHECKER. tools/mesh_validate.py --gate on the exported solid:
 *     a single run PASSES where the same moves as toolpath prisms FAIL; a
 *     sample of shells from every feature passes one by one; a whole stacked
 *     selection has no open edges and no piercing pairs.
 *  6. FUSED SELECTIONS (section 5 below). The junction audit, the multi-run
 *     export through the checker, its volume against an independent scanline
 *     union, the single-run pass-through, and tabletop's walls.
 *
 * Run: node tools/gcode-test/gscope-solid-check.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const G = require('../../nso-gcode-lines.js');
const SO = require('../../nso-gcode-solid.js');
const pace = require('../nso_pace.js');
const S = require('../../nso_path_sweep.js');

const REPO = path.join(__dirname, '..', '..');
let pass = 0, fail = 0;
function ok(cond, what) {
  if (cond) { pass++; console.log('  ok   ' + what); } else { fail++; console.log('  FAIL ' + what); }
}
function section(t) { console.log('\n' + t); }

// --- mesh helpers, independent of the builder --------------------------------

function soupVolume(t) { return SO.signedVolume(t, 0, t.length); }

/** Exact-coordinate edge audit of ONE closed shell: open, non-manifold, winding. */
function edgeAudit(t) {
  const key = (i) => t[i] + ',' + t[i + 1] + ',' + t[i + 2];
  const dir = new Map();
  for (let o = 0; o < t.length; o += 9) {
    const v = [key(o), key(o + 3), key(o + 6)];
    for (let e = 0; e < 3; e++) {
      const a = v[e], b = v[(e + 1) % 3];
      const k = a + '|' + b;
      dir.set(k, (dir.get(k) || 0) + 1);
    }
  }
  let open = 0, nonManifold = 0, winding = 0;
  for (const [k, n] of dir) {
    const [a, b] = k.split('|');
    const back = dir.get(b + '|' + a) || 0;
    if (n > 1) winding++;
    if (back === 0) open++;
    else if (n + back > 2) nonManifold++;
  }
  return { open, nonManifold, winding };
}

function writeSTL(soup, file) {
  const n = soup.length / 9, b = Buffer.alloc(84 + n * 50);
  b.writeUInt32LE(n, 80);
  for (let t = 0; t < n; t++) for (let k = 0; k < 9; k++) b.writeFloatLE(soup[t * 9 + k], 84 + t * 50 + 12 + k * 4);
  fs.writeFileSync(file, b);
}

function validate(file) {
  let out;
  try {
    out = execFileSync('python3', [path.join(REPO, 'tools', 'mesh_validate.py'), file, '--json'],
      { encoding: 'utf8', maxBuffer: 64 << 20 });
  } catch (e) { out = e.stdout; }
  const r = JSON.parse(out);
  const si = r.self_intersection || {};
  return { open: r.open_edges, nm: r.nonmanifold_edges, winding: r.inconsistent_winding_edges,
           degen: r.degenerate_tris, pierce: si.pierce || 0, coplanar: si.coplanar || 0,
           volume: r.signed_volume, verdict: r.verdict };
}

// ===========================================================================
section('1. Runs - where the parser says the bead stops');
// ===========================================================================
{
  const gc = [
    '; filament_diameter = 1.75', 'M83', 'G90',
    '; CHANGE_LAYER', '; Z_HEIGHT: 0.2', '; LAYER_HEIGHT: 0.2',
    'G1 X0 Y0 Z0.2 F3000',
    '; FEATURE: Outer wall',
    'G1 X10 Y0 E0.5',              // 0 run A
    'G1 F1200',                    //   feed only - not a stop
    'M106 S255',                   //   fan - not a stop
    'G1 X10 Y10 E0.5',             // 1 run A
    '; FEATURE: Inner wall',       //   feature tag - not a stop
    'G1 X0 Y10 E0.5',              // 2 run A
    'G1 E0.1',                     //   E-only prime - not a stop
    'G92 E0',                      //   E reset - not a stop
    'G2 X0 Y0 I0 J-5 E0.8',        // 3.. run A (arc chords, still one bead)
    'G1 X5 Y5 F9000',              //   travel -> stop
    'G1 X6 Y5 E0.05',              // run B
    'G1 E-0.8',                    //   retract -> stop
    'G1 X7 Y5 E0.05',              // run C
    'G1 X8 Y5 E-0.4',              //   wipe (moves while retracting) -> stop
    'G1 X9 Y5 E0.05',              // run D  (starts at 8,5)
    'G1 Z0.6',                     //   Z hop -> stop
    'G1 Z0.2',
    'G1 X10 Y5 E0.05',             // run E
    'G92 X20',                     //   reposition -> stop
    'G1 X21 Y5 E0.05',             // run F
  ].join('\n');
  const p = G.parseGcode(gc);
  const runs = p.moves.map((m) => m.run);
  const arcMoves = p.moves.filter((m) => m.index >= 3 && m.run === p.moves[0].run).length;
  ok(runs.slice(0, 3).every((r) => r === runs[0]), 'feed / fan / FEATURE / prime / G92 E do not break a run');
  ok(arcMoves > 1 && p.moves.slice(0, 3 + arcMoves).every((m) => m.run === runs[0]),
     'an arc\'s ' + arcMoves + ' chords are the same run as the lines before it');
  const distinct = [...new Set(runs)];
  ok(distinct.length === 6, 'six runs: A, then one per travel / retract / wipe / Z hop / G92 X (got ' + distinct.length + ')');
  ok(JSON.stringify(p.meta.runBreaks) === JSON.stringify({ travel: 1, retract: 2, zmove: 1, reposition: 1 }),
     'breaks counted by cause: ' + JSON.stringify(p.meta.runBreaks));
  ok(p.meta.runCount === 6, 'meta.runCount = 6');
  const arcEnd = p.moves[2 + arcMoves];
  ok(arcEnd.x1 === 0 && arcEnd.y1 === 0, 'an arc\'s last chord ends ON the commanded point (0, 0), bit for bit');

  // chains
  const all = SO.chainsOf(p.moves);
  ok(all.length === 6 && all[0].startedBy === 'first' && all.slice(1).every((c) => c.startedBy === 'run'),
     'chainsOf: one chain per run, each after the first started by a real stop');
  const gap = SO.chainsOf(p.moves.filter((m) => m.index !== 1));
  ok(gap.length === 7 && gap[1].startedBy === 'selection', 'a selection that skips a move caps the bead there, labelled "selection"');
  ok(SO.chainsOf(p.moves.slice().reverse()).length === 6, 'chainsOf sorts: print order, whatever order the selection came in');
}

// ===========================================================================
section('2. The closed sweep');
// ===========================================================================
{
  const prof = [[-0.1, -0.2], [0.1, -0.2], [0.1, 0.2], [-0.1, 0.2]];     // h 0.2, w 0.4
  const sq = [[0, 0, 0.1], [10, 0, 0.1], [10, 10, 0.1], [0, 10, 0.1]];
  const r = S.sweepClosed({ points: sq, profile: prof, up: [0, 0, 1] });
  ok(r.ok && r.closed, 'a square loop sweeps closed');
  const a = edgeAudit(r.tris);
  ok(a.open === 0 && a.nonManifold === 0 && a.winding === 0, 'no caps, and still closed and 2-manifold: ' + JSON.stringify(a));
  ok(r.tris.length / 9 === 2 * 4 * 4, '32 triangles: 4 walls x 2 per segment, no cap triangles');
  const v = soupVolume(r.tris);
  ok(Math.abs(v - 0.08 * 40) < 1e-5, 'volume = section 0.08 x centreline 40 = 3.2 exactly (got ' + v.toFixed(9) + ')');
  ok(r.stats.holonomy < 1e-12, 'a flat loop brings its frame home: holonomy ' + r.stats.holonomy.toExponential(2));
  const twisted = S.sweepClosed({ points: [[0, 0, 0], [10, 0, 0], [10, 10, 5], [0, 10, -3]], profile: prof });
  ok(!twisted.ok && /does not close its frame/.test(twisted.reason), 'a twisted space loop is refused by name, not forced: ' + (twisted.reason || '').slice(0, 60) + '...');
  const tight = S.sweepClosed({ points: [[0, 0, 0], [10, 0, 0], [10, 0.3, 0], [0, 0.3, 0]], profile: prof, up: [0, 0, 1] });
  ok(!tight.ok && tight.failAt && tight.failAt.segment != null, 'a loop narrower than its bead is refused with failAt ' + JSON.stringify(tight.failAt));
  const openR = S.sweep({ points: sq.concat([sq[0]]), profile: prof, up: [0, 0, 1] });
  ok(openR.ok && Math.abs(soupVolume(openR.tris) - v) < 1e-5,
     'the same loop swept OPEN encloses the same volume (the mitre is volume-neutral; the caps only meet)');
}

// --- section 5's independent volume: no kernel, no fuse code ---------------
//
// Every bead here is a flat prism (a Z band x a footprint), so the volume of
// any union of them is the sum over Z bands of (band thickness x the AREA OF
// THE UNION OF THE FOOTPRINTS present in that band). The area is taken by
// scanlines: on each line the footprints' intervals are merged exactly. The
// lines are rotated off every slicer axis (0.3137 rad) so no footprint edge
// lies along one - aligned, the error was 5e-4; rotated, it converges to 1e-7.
// `bottoms` overrides a shell's bottom Z (a seated bead reaches BOND_MM down).
function scanUnionVolume(built, bottoms, dy, only) {
  const c = Math.cos(0.3137), s = Math.sin(0.3137);
  const sh = built.shells.map((b, i) => {
    if (only && !only.has(i)) return { top: 0, bot: 0, tris: [] };
    const t = built.positions.subarray(b.triStart * 9, (b.triStart + b.triCount) * 9);
    let top = -Infinity, bot = Infinity;
    for (let k = 2; k < t.length; k += 3) { top = Math.max(top, t[k]); bot = Math.min(bot, t[k]); }
    if (bottoms && bottoms.has(i)) bot = bottoms.get(i);
    const tris = [];
    for (let o = 0; o < t.length; o += 9) {
      if (t[o + 2] !== top || t[o + 5] !== top || t[o + 8] !== top) continue;
      const q = [];
      for (let v = 0; v < 3; v++) { const x = t[o + v * 3], y = t[o + v * 3 + 1]; q.push(x * c - y * s, x * s + y * c); }
      tris.push(q);
    }
    return { top, bot, tris };
  });
  const zs = [];
  sh.forEach((b) => { if (b.tris.length) zs.push(b.top, b.bot); });
  zs.sort((a, b) => a - b);
  const Z = [];
  for (const z of zs) if (!Z.length || z - Z[Z.length - 1] > 1e-5) Z.push(z);
  let vol = 0;
  for (let k = 0; k + 1 < Z.length; k++) {
    const zm = (Z[k] + Z[k + 1]) / 2;
    const tris = [];
    sh.forEach((b) => { if (b.bot < zm && b.top > zm) b.tris.forEach((t) => tris.push(t)); });
    if (!tris.length) continue;
    let y0 = Infinity, y1 = -Infinity;
    tris.forEach((t) => { y0 = Math.min(y0, t[1], t[3], t[5]); y1 = Math.max(y1, t[1], t[3], t[5]); });
    const B = 0.5, nb = Math.max(1, Math.ceil((y1 - y0) / B)), bucket = Array.from({ length: nb }, () => []);
    tris.forEach((t) => {
      const a = Math.min(t[1], t[3], t[5]), b = Math.max(t[1], t[3], t[5]);
      for (let i = Math.floor((a - y0) / B); i <= Math.min(nb - 1, Math.floor((b - y0) / B)); i++) bucket[i].push(t);
    });
    let area = 0;
    for (let y = y0 + dy / 2; y < y1; y += dy) {
      const iv = [];
      for (const t of bucket[Math.min(nb - 1, Math.floor((y - y0) / B))]) {
        const xs = [];
        for (let e = 0; e < 3; e++) {
          const ax = t[e * 2], ay = t[e * 2 + 1], bx = t[(e + 1) % 3 * 2], by = t[(e + 1) % 3 * 2 + 1];
          if ((ay <= y) !== (by <= y)) xs.push(ax + (y - ay) * (bx - ax) / (by - ay));
        }
        if (xs.length === 2) iv.push([Math.min(xs[0], xs[1]), Math.max(xs[0], xs[1])]);
      }
      iv.sort((a, b) => a[0] - b[0]);
      let L = 0, cs = 0, ce = 0, on = false;
      for (const [a, b] of iv) {
        if (!on) { cs = a; ce = b; on = true; } else if (a > ce) { L += ce - cs; cs = a; ce = b; } else if (b > ce) ce = b;
      }
      if (on) L += ce - cs;
      area += L * dy;
    }
    vol += area * (Z[k + 1] - Z[k]);
  }
  return vol;
}

/** The bottoms fuseShells seated: every upper shell of a stack contact in a body fused the 'seated' way. */
function seatedBottoms(f) {
  const out = new Map();
  const seatedShell = new Set();
  f.bodies.forEach((b) => { if (b.way === 'seated') b.shells.forEach((s) => seatedShell.add(s)); });
  f.contacts.forEach((e) => {
    if (e.kind === 'stack' && seatedShell.has(e.upper)) out.set(e.upper, f.feet[e.upper].rest - SO.BOND_MM);
  });
  return out;
}

async function fusedSelections(slices, TMP) {
  // =========================================================================
  section('5. Fused selections - one solid where runs genuinely touch');
  // =========================================================================
  const { csgContext } = require('../nso_csg_node.js');
  const csg = csgContext();
  const wasm = await csg.NSO_CSG.load();
  const M = (t) => csg.NSO_CSG.soupToManifold(wasm, t);
  const partsOf = (a, b) => { const u = M(a).add(M(b)); const n = u.decompose().length; u.delete(); return n; };
  const box = (lo, hi) => {
    const v = [[lo[0], lo[1], lo[2]], [hi[0], lo[1], lo[2]], [hi[0], hi[1], lo[2]], [lo[0], hi[1], lo[2]],
               [lo[0], lo[1], hi[2]], [hi[0], lo[1], hi[2]], [hi[0], hi[1], hi[2]], [lo[0], hi[1], hi[2]]];
    const f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4],
               [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
    const o = [];
    for (const t of f) for (const i of t) o.push(...v[i]);
    return new Float32Array(o);
  };

  // --- 5a. the audit: what a junction between two runs actually is -----------
  const p = slices.supportwithinsupport;
  const walls = p.moves.filter((m) => m.feature === 'Inner wall' || m.feature === 'Outer wall');
  const wb = SO.buildSolid(walls);
  const ct = SO.shellContacts(wb);
  const kinds = { side: 0, stack: 0 };
  ct.edges.forEach((e) => kinds[e.kind]++);
  const layers = new Set(walls.map((m) => m.z)).size;
  console.log('  Inner + Outer wall: ' + walls.length + ' moves over ' + layers + ' layers, ' + wb.shells.length +
              ' run shells, ' + ct.edges.length + ' junctions ' + JSON.stringify(kinds) + ', ' + ct.snapped.length +
              ' bottoms off the plane they rest on');
  ok(kinds.stack > 0 && kinds.side > 0, 'two kinds of junction: stacked (a bead on the one below) and side by side (neighbours that overlap)');
  const f32step = ct.snapped.every((sn) => Math.abs(sn.to - sn.from) <= 2 * S.ulp32(Math.abs(sn.to)));
  ok(ct.snapped.length > 0 && f32step,
     ct.snapped.length + ' shells sit one float32 step off the top they rest on (f32(z - h) vs f32(z below)) - rounding, not a gap');
  // A side junction between the inner and outer wall of a layer is a real overlap: centrelines closer than the bead.
  const byZ = new Map();
  walls.forEach((m) => { if (!byZ.has(m.z)) byZ.set(m.z, []); byZ.get(m.z).push(m); });
  const segD = (a, b) => {
    const pd = (px, py, x0, y0, x1, y1) => {
      const dx = x1 - x0, dy = y1 - y0, L = dx * dx + dy * dy;
      let t = L ? ((px - x0) * dx + (py - y0) * dy) / L : 0; t = Math.max(0, Math.min(1, t));
      return Math.hypot(px - x0 - t * dx, py - y0 - t * dy);
    };
    return Math.min(pd(a.x0, a.y0, b.x0, b.y0, b.x1, b.y1), pd(a.x1, a.y1, b.x0, b.y0, b.x1, b.y1),
                    pd(b.x0, b.y0, a.x0, a.y0, a.x1, a.y1), pd(b.x1, b.y1, a.x0, a.y0, a.x1, a.y1));
  };
  let spacing = Infinity;
  for (const [, L] of byZ) {
    const I = L.filter((m) => m.feature === 'Inner wall'), O = L.filter((m) => m.feature === 'Outer wall');
    for (const a of I) for (const b of O) spacing = Math.min(spacing, segD(a, b));
  }
  ok(spacing < walls[0].width, 'inner and outer wall centrelines ' + spacing.toFixed(3) + ' mm apart, beads ' +
     walls[0].width.toFixed(3) + ' mm wide: a side junction is a genuine overlap of ' + (walls[0].width - spacing).toFixed(3) + ' mm');
  // What the kernel does with each kind, on plain boxes.
  const f = Math.fround, step = S.ulp32(1.2);
  ok(partsOf(box([0, 0, 0], [1, 1, f(1.2)]), box([0.2, 0.2, f(1.2)], [1.2, 1.2, 1.5])) === 1,
     'kernel: two beads meeting face to face (one on the other) merge into one');
  ok(partsOf(box([0, 0, 0], [1, 1, f(1.2)]), box([0.2, 0.2, f(1.2) + step], [1.2, 1.2, 1.5])) === 2,
     'kernel: one float32 step apart they do not - hence the plane snap');
  ok(partsOf(box([0, 0, 0], [1, 1, 1]), box([1, 1, 0], [2, 2, 1])) === 2,
     'kernel: meeting only along an edge is no junction - and the contact test never asks (a footprint must overlap with area)');

  // --- 5b. the walls, fused, through the canonical checker --------------------
  let t0 = Date.now();
  const fw = await SO.fuseShells(wb, { csg: csg.NSO_CSG });
  const msW = Date.now() - t0;
  fw.feet = ct.feet;
  console.log('  ' + fw.reason + ' (' + msW + ' ms; ways ' + JSON.stringify(fw.stats.ways) + ')');
  ok(fw.ok && fw.stats.seams === 0 && fw.stats.splits.length === 0,
     'every junction of the walls is fused: ' + fw.stats.unions + ' unions, 0 left in contact');
  const fW = path.join(TMP, 'walls.fused.stl');
  writeSTL(fw.positions, fW);
  const vW = validate(fW);
  console.log('  canonical checker, whole export: ' + JSON.stringify(vW));
  ok(vW.verdict === 'PASS' && vW.open === 0 && vW.nm === 0 && vW.pierce === 0 && vW.degen === 0,
     'the whole multi-run export PASSES tools/mesh_validate.py (unfused, the same 144 shells report non-manifold edges wherever they touch)');
  const fU = path.join(TMP, 'walls.shells.stl');
  writeSTL(wb.positions, fU);
  const vU = validate(fU);
  ok(vU.verdict === 'FAIL' && vU.nm > 0, 'the same selection unfused FAILS it: ' + vU.nm + ' non-manifold edges, ' + vU.pierce + ' piercing pairs where shells meet');
  // The bodies are separate because the part is: no two of them touch.
  const soups = fw.bodies.map((b) => fw.positions.subarray(b.triStart * 9, (b.triStart + b.triCount) * 9));
  let merged = 0;
  for (let i = 0; i < soups.length; i++) for (let j = i + 1; j < soups.length; j++) if (partsOf(soups[i], soups[j]) < 2) merged++;
  ok(fw.bodies.length === fw.stats.groups && merged === 0,
     fw.bodies.length + ' bodies, one per connected group, and the kernel merges no two of them - they do not touch (no wall at layers 28-30)');
  // Volume: the independent scanline union of the SAME swept runs.
  const seat = seatedBottoms(fw);
  const vScan = scanUnionVolume(wb, seat, 0.004);
  const vShells = wb.shells.reduce((a, b) => a + b.volume, 0);
  const relW = Math.abs(fw.stats.fusedVolume - vScan) / vScan;
  console.log('  volume: runs ' + vShells.toFixed(4) + ' mm3, independent union ' + vScan.toFixed(4) + ', fused ' +
              fw.stats.fusedVolume.toFixed(4) + ' (rel ' + relW.toExponential(2) + '); overlap counted once ' +
              fw.stats.overlapRemovedMm3.toFixed(4) + ', seated ' + seat.size + ' shells (bound ' + fw.stats.seatBoundMm3.toFixed(4) + ')');
  ok(relW < 1e-5, 'fused volume = the sum of the runs minus their real overlap, measured without the kernel (rel ' + relW.toExponential(2) + ')');
  const vScanExact = seat.size ? scanUnionVolume(wb, null, 0.004) : vScan;
  ok(fw.stats.fusedVolume - vScanExact >= -1e-3 && fw.stats.fusedVolume - vScanExact <= fw.stats.seatBoundMm3 + 1e-3,
     'what seating adds (' + (fw.stats.fusedVolume - vScanExact).toFixed(4) + ' mm3) is within its reported bound (' + fw.stats.seatBoundMm3.toFixed(4) + ')');

  // --- 5c. the single run: untouched, exact, fast ------------------------------
  const inner = p.moves.filter((m) => m.feature === 'Inner wall');
  const one = SO.buildSolid(SO.chainsOf(inner)[5].moves);
  /* "fast" in calibration loops (tools/nso_pace.js), not ms: ONE_LOOPS_MAX is
     the old 50 ms on the box it was set on - a kernel load is seconds. */
  const ONE_LOOPS_MAX = 0.17;
  const calO = pace.calibrate();
  t0 = Date.now();
  const fo = await SO.fuseShells(one, { csg: csg.NSO_CSG });
  const msO = Date.now() - t0;
  const calMeanO = (calO + pace.calibrate()) / 2, loopsO = msO / calMeanO;
  ok(fo.ok && fo.stats.contacts === 0 && fo.stats.unions === 0 && fo.bodies.length === 1 && !fo.bodies[0].fused,
     'one continuous run: no junction, no union, one body as swept');
  ok(fo.positions.length === one.positions.length && fo.positions.every((v, i) => v === one.positions[i]),
     'bit for bit the sweep\'s own shell - still exact (volume ' + fo.stats.fusedVolume.toFixed(6) + ' = ' + one.stats.solidVolume.toFixed(6) + ')');
  console.log(pace.finding('the single run\'s fuse', { ms: msO, cal: calMeanO, loops: loopsO }));
  ok(loopsO < ONE_LOOPS_MAX, 'and still fast: ' + loopsO.toFixed(3) + ' calibration loops (' + msO + ' ms), the kernel never loaded for it');
  // Runs that touch nothing are passed through the same way inside a bigger selection.
  const apart = SO.buildSolid(inner.filter((m) => m.layer === 3 || m.layer === 9));
  const fa = await SO.fuseShells(apart, { csg: csg.NSO_CSG });
  ok(fa.stats.contacts === 0 && fa.positions.every((v, i) => v === apart.positions[i]),
     'two runs six layers apart: no junction between them, both exported exactly as swept');

  // The guard: past its limits the union is refused by name, never started.
  const g1 = await SO.fuseShells(wb, { csg: csg.NSO_CSG, maxJunctions: 100 });
  const g2 = await SO.fuseShells(wb, { csg: csg.NSO_CSG, maxShells: 100 });
  ok(!g1.ok && /305 junctions is over the 100/.test(g1.reason) && !g2.ok && /144 runs is over the 100/.test(g2.reason),
     'over the limits (defaults ' + SO.MAX_SHELLS + ' runs, ' + SO.MAX_JUNCTIONS + ' junctions) it refuses by name and the caller exports the shells: "' + g1.reason + '"');

  // --- 5d. the hard case: tabletop's walls ------------------------------------
  const q = slices.tabletop;
  const tw = q.moves.filter((m) => m.feature === 'Outer wall' || m.feature === 'Inner wall');
  const tb = SO.buildSolid(tw);
  t0 = Date.now();
  const ft = await SO.fuseShells(tb, { csg: csg.NSO_CSG });
  const msT = Date.now() - t0;
  console.log('  tabletop walls: ' + ft.reason + ' (' + msT + ' ms; ways ' + JSON.stringify(ft.stats.ways) +
              ', ' + ft.stats.slivers + ' zero-volume kernel slivers dropped)');
  ft.stats.splits.forEach((sp) => console.log('    a group of ' + sp.shells + ' no way fused soundly (' + sp.tried.join(' | ') +
                                              ') - set aside ' + sp.setAside.length + ' bead(s) at the located defect'));
  ok(ft.ok && ft.stats.seams <= 0.01 * ft.stats.contacts,
     (ft.stats.contacts - ft.stats.seams) + ' of ' + ft.stats.contacts + ' junctions fused; ' + ft.stats.seams +
     ' left as faces in contact where the kernel gave no sound solid, and reported');
  const dirT = path.join(TMP, 'tabletop-bodies');
  fs.mkdirSync(dirT);
  ft.bodies.forEach((b, i) => { if (b.fused) writeSTL(ft.positions.subarray(b.triStart * 9, (b.triStart + b.triCount) * 9), path.join(dirT, i + '.stl')); });
  const pyT = [
    'import sys, json, pathlib',
    'sys.path.insert(0, ' + JSON.stringify(path.join(REPO, 'tools')) + ')',
    'import mesh_validate as mv',
    'fails = []',
    'files = sorted(pathlib.Path(' + JSON.stringify(dirT) + ').glob("*.stl"))',
    'for f in files:',
    '    r = mv.validate(f, mv.WELD_TOL, 100.0, True, mv.SELFINT_EPS)',
    '    if r["verdict"] != "PASS": fails.append([f.name, r["verdict_fails"]])',
    'print(json.dumps({"n": len(files), "fails": fails}))',
  ].join('\n');
  const bt = JSON.parse(execFileSync('python3', ['-c', pyT], { encoding: 'utf8', maxBuffer: 64 << 20 }));
  bt.fails.forEach((x) => console.log('    ' + JSON.stringify(x)));
  ok(bt.n === ft.bodies.filter((b) => b.fused).length && bt.fails.length === 0,
     'every fused body of tabletop\'s walls, alone, PASSES tools/mesh_validate.py (' + bt.n + ' bodies) - none is exported defective');
  // Volume, body by body: each fused body against the independent union of
  // exactly its own runs. (The export's TOTAL still counts twice whatever a
  // set-aside bead overlaps - that is the part left unfused, and why it is
  // reported - so the total is not the check; every body is.)
  ft.feet = SO.shellContacts(tb).feet;
  const seatT = seatedBottoms(ft);
  let worstT = 0, sumFused = 0, sumScan = 0;
  ft.bodies.filter((b) => b.fused).forEach((b) => {
    const v = scanUnionVolume(tb, seatT, 0.004, new Set(b.shells));
    worstT = Math.max(worstT, Math.abs(b.volume - v) / v);
    sumFused += b.volume; sumScan += v;
  });
  console.log('  volume: fused bodies ' + sumFused.toFixed(4) + ' mm3, independent union of each body\'s runs ' +
              sumScan.toFixed(4) + ' (worst body rel ' + worstT.toExponential(2) + '); ' + ft.stats.setAside + ' bead(s) set aside at ' +
              ft.stats.splits.length + ' located defect site(s)');
  ok(worstT < 1e-5, 'tabletop walls: every fused body\'s volume = its runs minus their real overlap, measured without the kernel (worst rel ' +
     worstT.toExponential(2) + ')');
}

// ===========================================================================
section('3. Real slices - every move');
// ===========================================================================
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gscope-solid-'));
const slices = {};
(async () => {
  for (const name of ['supportwithinsupport', 'tabletop']) {
    const bytes = new Uint8Array(fs.readFileSync(path.join(REPO, 'fixtures', '3mf', name + '.gcode.3mf')));
    const res = await G.readSlicedGcode3MF(bytes);
    const p = res.parsed;
    slices[name] = p;
    const t0 = Date.now();
    const b = SO.buildSolid(p.moves);
    const ms = Date.now() - t0;
    const st = b.stats;
    console.log('  ' + name + ': ' + p.moves.length + ' moves, ' + p.meta.runCount + ' runs ' +
                JSON.stringify(p.meta.runBreaks) + ' -> ' + st.chains + ' chains, ' + st.shells + ' shells (' +
                st.closedLoops + ' seam-closed, ' + st.forcedSplits.length + ' forced splits), ' + ms + ' ms');
    ok(st.moves === p.moves.length, name + ': every move is in the solid');
    ok(st.starts.discontinuous === 0, name + ': the parser\'s runs are geometrically continuous (0 discontinuous joins)');
    ok(st.starts.run === p.meta.runCount - 1, name + ': a chain starts exactly where a run does (' + st.starts.run + ' + first)');
    let bad = 0, neg = 0;
    for (const sh of b.shells) {
      const t = b.positions.subarray(sh.triStart * 9, (sh.triStart + sh.triCount) * 9);
      const a = edgeAudit(t);
      if (a.open || a.nonManifold || a.winding) bad++;
      if (!(sh.volume > 0)) neg++;
    }
    ok(bad === 0, name + ': all ' + b.shells.length + ' shells closed, 2-manifold, consistently wound (' + bad + ' not)');
    ok(neg === 0, name + ': every shell encloses positive volume (outward normals)');
    const rel = Math.abs(st.solidVolume - st.expectedVolume) / st.expectedVolume;
    ok(rel < 1e-5, name + ': solid volume ' + st.solidVolume.toFixed(4) + ' = section x centreline ' +
       st.expectedVolume.toFixed(4) + ' (rel ' + rel.toExponential(2) + ', float32 storage)');
    const id = Math.abs(st.expectedVolume - (st.toolpathVolume + st.seamAddedMm3)) / st.expectedVolume;
    ok(id < 1e-9, name + ': = toolpath-view volume ' + st.toolpathVolume.toFixed(4) + ' + seam closures ' +
       st.seamAddedMm3.toFixed(4) + ' exactly (rel ' + id.toExponential(2) + ')');
    ok(st.forcedSplits.every((f) => /miter has eaten|doubles back|crosses itself/.test(f.reason)),
       name + ': every forced split is a named sweep refusal, never an unexplained cut');
    ok(st.droppedSteps === 0, name + ': no step dropped for being under the float32 floor');
  }

  // =========================================================================
  section('4. Canonical checker - tools/mesh_validate.py');
  // =========================================================================
  const p = slices.supportwithinsupport;
  const inner = p.moves.filter((m) => m.feature === 'Inner wall');
  const loop = SO.chainsOf(inner)[5].moves;
  const one = SO.buildSolid(loop);
  const fOne = path.join(TMP, 'one-run.solid.stl'), fPr = path.join(TMP, 'one-run.prisms.stl');
  writeSTL(one.positions, fOne);
  writeSTL(G.buildLineGeometry(loop).positions, fPr);
  const vOne = validate(fOne), vPr = validate(fPr);
  console.log('  one Inner wall run, solid : ' + JSON.stringify(vOne));
  console.log('  same moves as prisms      : ' + JSON.stringify(vPr));
  ok(vOne.verdict === 'PASS' && vOne.open === 0 && vOne.nm === 0 && vOne.pierce === 0,
     'one continuous run exported as solid PASSES the full gate (open 0, non-manifold 0, pierce 0)');
  ok(vPr.verdict === 'FAIL' && vPr.pierce > 0,
     'the same moves as per-move prisms FAIL it (' + vPr.pierce + ' piercing pairs at the corners) - what the sweep fixes');
  ok(Math.abs(vOne.volume - vPr.volume) / vPr.volume < 1e-3,
     'and hold the same material: ' + vOne.volume.toFixed(4) + ' vs ' + vPr.volume.toFixed(4) +
     ' mm^3 (difference = the seam closure, ' + one.stats.seamAddedMm3.toFixed(4) + ')');

  // One shell of every kind, from every feature: closed loops, open runs, the
  // pieces of a forced split.
  const all = SO.buildSolid(p.moves);
  const byKind = new Map();
  all.shells.forEach((sh, i) => {
    const k = sh.feature + (sh.closed ? ' closed' : ' open');
    if (!byKind.has(k)) byKind.set(k, []);
    byKind.get(k).push(i);
  });
  const splitMoves = new Set(all.stats.forcedSplits.map((f) => f.moveIndex));
  const splitShell = all.shells.findIndex((sh) => sh.moveIds.some((id) => splitMoves.has(id)));
  const sample = [];
  for (const [, ids] of byKind) sample.push(ids[0], ids[Math.floor(ids.length / 2)], ids[ids.length - 1]);
  if (splitShell >= 0) sample.push(splitShell);
  const uniq = [...new Set(sample)];
  let passN = 0;
  const fails = [];
  uniq.forEach((i) => {
    const sh = all.shells[i];
    const f = path.join(TMP, 'shell-' + i + '.stl');
    writeSTL(all.positions.subarray(sh.triStart * 9, (sh.triStart + sh.triCount) * 9), f);
    const r = validate(f);
    if (r.verdict === 'PASS') passN++; else fails.push(sh.feature + '#' + i + ' ' + JSON.stringify(r));
  });
  console.log('  sampled ' + uniq.length + ' shells over ' + byKind.size + ' feature/kind groups: ' + passN + ' PASS');
  fails.forEach((f) => console.log('    ' + f));
  ok(passN === uniq.length, 'every sampled shell, alone, PASSES the full gate - including a piece of a forced split');

  // Then EVERY shell of the file, through the same validator in one Python
  // process (its own validate(), default gate, nothing re-implemented).
  const dirAll = path.join(TMP, 'all');
  fs.mkdirSync(dirAll);
  all.shells.forEach((sh, i) => writeSTL(all.positions.subarray(sh.triStart * 9, (sh.triStart + sh.triCount) * 9),
    path.join(dirAll, String(i).padStart(5, '0') + '.stl')));
  const py = [
    'import sys, json, pathlib',
    'sys.path.insert(0, ' + JSON.stringify(path.join(REPO, 'tools')) + ')',
    'import mesh_validate as mv',
    'fails = []',
    'files = sorted(pathlib.Path(' + JSON.stringify(dirAll) + ').glob("*.stl"))',
    'for f in files:',
    '    r = mv.validate(f, mv.WELD_TOL, 100.0, True, mv.SELFINT_EPS)',
    '    if r["verdict"] != "PASS": fails.append([f.name, r["verdict_fails"]])',
    'print(json.dumps({"n": len(files), "fails": fails}))',
  ].join('\n');
  const batch = JSON.parse(execFileSync('python3', ['-c', py], { encoding: 'utf8', maxBuffer: 64 << 20 }));
  batch.fails.slice(0, 5).forEach((f) => console.log('    ' + JSON.stringify(f)));
  ok(batch.n === all.shells.length && batch.fails.length === 0,
     'ALL ' + batch.n + ' shells of supportwithinsupport, one by one, PASS the full gate (' + batch.fails.length + ' fail)');

  // A stacked selection: 45 Inner wall loops, one per layer, touching face to face.
  const stack = SO.buildSolid(inner);
  const fSt = path.join(TMP, 'inner-stack.solid.stl');
  writeSTL(stack.positions, fSt);
  const vSt = validate(fSt);
  console.log('  45 stacked Inner wall loops: ' + JSON.stringify(vSt));
  ok(vSt.open === 0 && vSt.degen === 0 && vSt.pierce === 0,
     'a stacked multi-run selection: open 0, degenerate 0, pierce 0 - watertight, nothing passes through anything');
  ok(vSt.nm > 0,
     'and, unfused, its non-manifold edges are where one layer\'s bead sits on the next (' + vSt.nm + '): separate shells touching - what section 5 fuses');

  await fusedSelections(slices, TMP);

  fs.rmSync(TMP, { recursive: true, force: true });
  console.log('\n' + (fail ? 'FAIL' : 'PASS') + '  ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
