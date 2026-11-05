#!/usr/bin/env node
/*
 * Z-height filtering + the real-file validation tier.
 *
 * Two things are proven here, and they are different in kind.
 *
 * 1. THE Z FILTER (tiers 1-3). Feature grouping answers "which moves are
 *    Support interface". It does NOT answer "which moves are Support interface
 *    ON THIS LAYER" - a feature group is every move of that feature at every
 *    height, so a real slice arrives as dozens of layers stacked and overlaid.
 *    The Z window adds the missing axis, and these tiers assert that one layer
 *    of one feature really does come out with every other layer of that same
 *    feature left out, and that what comes out is still solid enough to export.
 *
 * 2. THE REAL FILES (tier 4). `gcode-lines-check.js` proves the importer
 *    against SYNTHETIC ground truth - a fixture whose correct answer is known
 *    because this repo computed it. That is necessary and it is not sufficient:
 *    it cannot catch a wrong reading of a structure Bambu Studio writes and
 *    this repo never thought to generate. So this tier reads two real sliced
 *    files and checks the importer's measurements against numbers that were
 *    HAND-VERIFIED from the slice itself, independently of any code here:
 *
 *      fixtures/3mf/tabletop.gcode.3mf
 *        - support-interface strand width ~= 0.61 mm
 *        - exactly 2 stacked support-interface layers, zigzagging in
 *          OPPOSITE directions
 *        - NO separate border / perimeter feature at the interface - the edge
 *          is branch-tip convergence, not a contour
 *
 *    Those three are the load-bearing assertions in this file. They are the
 *    tier docs/GCODE-TOOLPATH-IMPORT.md recorded as never having been run.
 *
 * Run: node tools/gcode-test/gcode-zfilter-check.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const G = require('../../nso-gcode-lines.js');

const REPO = path.join(__dirname, '..', '..');
const TABLETOP = path.join(REPO, 'fixtures', '3mf', 'tabletop.gcode.3mf');
const SUPPORT2 = path.join(REPO, 'fixtures', '3mf', 'supportwithinsupport.gcode.3mf');
const FIXTURE = path.join(REPO, 'fixtures', '3mf', 'toolpath-ground-truth.gcode.3mf');

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

/** Length-weighted mean of a move property - the physically right average. */
function weighted(moves, key) {
  let num = 0, den = 0;
  moves.forEach(m => { num += m[key] * m.length; den += m.length; });
  return den > 0 ? num / den : 0;
}

/** Distinct printing heights in a move list. */
function heights(moves) {
  const out = [];
  moves.forEach(m => {
    for (let i = 0; i < out.length; i++) if (Math.abs(out[i] - m.z) <= G.Z_EPS) return;
    out.push(m.z);
  });
  return out.sort((a, b) => a - b);
}

/**
 * The dominant direction of a set of moves, in degrees folded to [0, 180) -
 * a zigzag's raster angle. Length-weighted, because a few short turnaround
 * moves must not outvote the long strokes that make the pattern.
 */
function dominantAngle(moves) {
  const bins = new Map();
  moves.forEach(m => {
    let a = ((m.angle * 180 / Math.PI) % 180 + 180) % 180;
    const k = Math.round(a / 5) * 5 % 180;
    bins.set(k, (bins.get(k) || 0) + m.length);
  });
  let best = -1, bestL = -1;
  bins.forEach((L, k) => { if (L > bestL) { bestL = L; best = k; } });
  return { angle: best, length: bestL };
}

/** Signed volume / closure of one bead's shell - the Extract solidity test. */
function shellStats(pos) {
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
  let open = 0;
  counts.forEach(c => { if (c === 1) open++; });
  let vol = 0, degen = 0;
  for (let i = 0; i < pos.length; i += 9) {
    const ax = pos[i], ay = pos[i + 1], az = pos[i + 2];
    const bx = pos[i + 3], by = pos[i + 4], bz = pos[i + 5];
    const cx = pos[i + 6], cy = pos[i + 7], cz = pos[i + 8];
    vol += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
    const ux = bx - ax, uy = by - ay, uz = bz - az, vx = cx - ax, vy = cy - ay, vz = cz - az;
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    if (Math.sqrt(nx * nx + ny * ny + nz * nz) / 2 < 1e-12) degen++;
  }
  return { open, vol, degen, tris: pos.length / 9 };
}

// ===========================================================================
section('1. The Z window, on its own terms');
// ===========================================================================
{
  ok(G.zWindow(3, 1).zLo === 1 && G.zWindow(3, 1).zHi === 3, 'a window normalises a reversed pair');
  const w = G.zWindowAround(5, 0.25);
  near(w.zLo, 4.75, 0, 'a centre + half extent gives the low bound');
  near(w.zHi, 5.25, 0, 'a centre + half extent gives the high bound');
  const tight = G.zWindowAround(5, 0);
  ok(G.moveInZWindow({ z: 5 }, tight), 'a zero-thickness window still holds its own Z');
  ok(!G.moveInZWindow({ z: 5.2 }, tight), 'a zero-thickness window excludes the next layer');

  // The printing Z is tested, NOT the bead's span, and this is the case that
  // tells the two apart. Layers at 4.8 and 5.1, 0.3 mm apart. The bead printed
  // at 5.1 spans 4.8 .. 5.1, so its underside sits exactly ON the 4.8 layer's
  // printing Z - a span test would pull it into 4.8's window and there would be
  // no isolation left to have. A printing-Z test does not.
  const above = { z: 5.1, height: 0.3 };            // spans 4.8 .. 5.1
  const winBelow = G.zWindowAround(4.8, 0);
  ok(above.z - above.height <= winBelow.zHi + G.Z_EPS,
     'the test case is real: the bead above SPANS down onto this layer\'s Z');
  ok(!G.moveInZWindow(above, winBelow),
     'and it is still NOT in this layer\'s window - the printing Z is what counts');
  ok(G.moveInZWindow({ z: 4.8, height: 0.3 }, winBelow),
     'while the bead actually printed at this Z is in it');

  ok(G.moveInZWindow({ z: 5 }, G.zWindow(5, 5)), 'the bounds are inclusive');
  ok(!G.moveInZWindow(null, tight) && !G.moveInZWindow({ z: 5 }, null),
     'a missing move or window is not a match rather than a throw');

  const list = [{ z: 1 }, { z: 2 }, { z: 3 }, { z: 2 }];
  ok(G.movesInZWindow(list, G.zWindow(1.5, 2.5)).length === 2, 'a window selects only its own moves');
  ok(G.movesInZWindow(list, G.zWindow(1.5, 2.5))[0] === list[1],
     'filtering preserves path order and returns the moves themselves');
}

// ===========================================================================
section('2. Z filtering over the ground-truth fixture');
// ===========================================================================
async function overFixture() {
  const res = await G.readSlicedGcode3MF(new Uint8Array(fs.readFileSync(FIXTURE)));
  const parsed = res.parsed;
  ok(parsed.layers.length > 1, 'the fixture has more than one layer to isolate between');

  // Every layer, isolated, must account for every move exactly once.
  let total = 0;
  const seenZ = [];
  for (let li = 0; li < parsed.layers.length; li++) {
    const win = G.layerZWindow(parsed, li);
    ok(!!win, 'layer ' + li + ' has a Z window');
    const got = G.movesInZWindow(parsed.moves, win);
    ok(got.length > 0, 'layer ' + li + ' isolates a non-empty set of moves');
    ok(heights(got).length === 1, 'layer ' + li + ' isolates exactly ONE printing height');
    seenZ.push(heights(got)[0]);
    total += got.length;
  }
  ok(total === parsed.moves.length,
     'the isolated layers partition the toolpath exactly - ' + total + ' of ' + parsed.moves.length);
  ok(new Set(seenZ.map(z => z.toFixed(6))).size === parsed.layers.length,
     'no two layers share a printing height');

  // THE POINT OF THE WHOLE EXERCISE: a feature restricted to one layer must
  // drop that feature's other layers, and keep only its own.
  const multi = {};
  parsed.moves.forEach(m => {
    multi[m.feature] = multi[m.feature] || new Set();
    multi[m.feature].add(m.z.toFixed(6));
  });
  const spread = Object.keys(multi).filter(k => multi[k].size > 1);
  ok(spread.length > 0, 'the fixture has at least one feature spanning several layers (' +
     spread.join(', ') + ')');
  spread.forEach(name => {
    const all = parsed.moves.filter(m => m.feature === name);
    const li = G.layerIndexAtZ(parsed, all[0].z);
    const win = G.layerZWindow(parsed, li);
    const iso = G.movesInZWindow(all, win);
    ok(iso.length > 0 && iso.length < all.length,
       '"' + name + '" on one layer is a strict subset of the whole feature (' +
       iso.length + ' of ' + all.length + ')');
    ok(heights(iso).length === 1,
       '"' + name + '" on one layer is at ONE height - isolated from its own other layers');
  });

  // featuresInZWindow is the Z-filtered counterpart of the importer's groups.
  const win0 = G.layerZWindow(parsed, 0);
  const groups = G.featuresInZWindow(parsed, win0);
  ok(groups.length > 0, 'featuresInZWindow returns groups for a layer');
  ok(groups.every(g => heights(g.moves).length === 1),
     'every Z-filtered group is confined to one height');
  ok(groups.every(g => g.built && g.built.positions.length === g.moves.length * G.FLOATS_PER_MOVE),
     'every Z-filtered group carries built geometry for exactly its own moves');

  // layerIndexAtZ round-trips against layerZWindow.
  let rt = 0;
  for (let li = 0; li < parsed.layers.length; li++) {
    const w = G.layerZWindow(parsed, li);
    if (G.layerIndexAtZ(parsed, (w.zLo + w.zHi) / 2) === li) rt++;
  }
  ok(rt === parsed.layers.length, 'layerIndexAtZ round-trips every layer (' + rt + ')');

  // zLevels agrees with the layer table.
  ok(G.zLevels(parsed).length === parsed.layers.length,
     'zLevels finds one printing height per layer');

  // A slab window takes several layers - the reference capture box's case.
  const zs = G.zLevels(parsed);
  if (zs.length >= 2) {
    const slab = G.zWindowAround((zs[0] + zs[1]) / 2, (zs[1] - zs[0]) / 2 + 1e-4);
    ok(heights(G.movesInZWindow(parsed.moves, slab)).length === 2,
       'a thicker window takes a slab of two layers, not one');
  }

  // The feature-colour table covers what the reference tool isolates.
  ['Bottom surface', 'Bridge', 'Floating vertical shell', 'Gap infill', 'Inner wall',
   'Internal solid infill', 'Outer wall', 'Overhang wall', 'Sparse infill', 'Support',
   'Support interface', 'Top surface', 'Travel'].forEach(name => {
    ok(G.colorForFeature(name) !== G.OTHER_COLOR,
       'the reference tool\'s "' + name + '" has its own colour here');
  });
  ok(G.colorForFeature('Something Bambu has not invented yet') === G.OTHER_COLOR,
     'an unknown feature still gets a colour rather than undefined');
}

// ===========================================================================
section('3. Extracting one isolated layer - the clean-STL standard');
// ===========================================================================
async function extractOneLayer() {
  const res = await G.readSlicedGcode3MF(new Uint8Array(fs.readFileSync(FIXTURE)));
  const parsed = res.parsed;

  // The extraction unit: a whole layer at one Z, every feature at that height.
  const li = 1 < parsed.layers.length ? 1 : 0;
  const win = G.layerZWindow(parsed, li);
  const moves = G.movesAtZ(parsed, (win.zLo + win.zHi) / 2);
  ok(moves.length > 0, 'the whole-layer-at-one-Z unit is non-empty');
  ok(heights(moves).length === 1, 'the extraction unit is at exactly ONE Z');

  const feats = new Set(moves.map(m => m.feature));
  ok(feats.size >= 1, 'the unit spans every feature at that height (' +
     Array.from(feats).join(', ') + ')');

  const built = G.buildLineGeometry(moves);
  ok(built.positions.length === moves.length * G.FLOATS_PER_MOVE,
     'the isolated layer builds geometry for exactly its own moves');

  const st = shellStats(built.positions);
  ok(st.open === 0, 'the isolated layer has NO open edges - nothing leaks');
  ok(st.degen === 0, 'the isolated layer has no degenerate triangles');
  ok(st.vol > 0, 'the isolated layer has positive signed volume - not inside-out');

  // Every bead in it is individually a closed, positive solid.
  let bad = 0;
  moves.forEach(m => {
    const one = shellStats(new Float32Array(G.extrudeFlatLine(m, [])));
    if (one.open !== 0 || !(one.vol > 0) || one.tris !== G.TRIS_PER_MOVE) bad++;
  });
  ok(bad === 0, 'every bead in the isolated layer is a closed solid of its own');

  // The Z span of the export is one layer and no more - the thing the whole
  // filter exists to guarantee.
  let zLo = Infinity, zHi = -Infinity;
  for (let i = 2; i < built.positions.length; i += 3) {
    zLo = Math.min(zLo, built.positions[i]);
    zHi = Math.max(zHi, built.positions[i]);
  }
  // Positions are a Float32Array, so a Z of 0.4 reads back as 0.40000000596.
  // FLOAT32_EPS is that storage error, not slack in the claim.
  const FLOAT32_EPS = 1e-5;
  const h = moves[0].height;
  near(zHi - zLo, h, FLOAT32_EPS, 'the exported Z span is exactly one layer height');
  ok(zHi <= moves[0].z + FLOAT32_EPS,
     'nothing in the export sits above the layer it came from');

  // And it really is a strict subset: other layers exist and are not in it.
  ok(moves.length < parsed.moves.length,
     'the isolated layer is a strict subset of the toolpath (' + moves.length +
     ' of ' + parsed.moves.length + ')');
}

// ===========================================================================
section('4. Real Bambu Studio slices - the hand-verified tier');
// ===========================================================================
async function realFiles() {
  for (const p of [TABLETOP, SUPPORT2]) {
    if (!fs.existsSync(p)) {
      fail++; failures.push(path.basename(p) + ': missing');
      console.log('  FAIL ' + path.basename(p) + ' is not committed');
      return;
    }
  }

  // ---- both files: the importer read the file, not its own defaults -------
  const parsedOf = {};
  for (const p of [TABLETOP, SUPPORT2]) {
    const label = path.basename(p);
    const res = await G.readSlicedGcode3MF(new Uint8Array(fs.readFileSync(p)), { name: label });
    const parsed = res.parsed;
    parsedOf[label] = parsed;
    ok(parsed.meta.assumed === false, label + ': nothing assumed - every number came from the file');
    ok(parsed.meta.filamentDiameterFromFile, label + ': filament diameter read from the file');
    ok(parsed.moves.length > 0 && parsed.layers.length > 0,
       label + ': ' + parsed.moves.length + ' moves over ' + parsed.layers.length + ' layers');

    // Layer index and printing Z are 1:1 on real Bambu output, which is what
    // lets the Z-keyed extraction unit and the layer table agree.
    ok(G.zLevels(parsed).length === parsed.layers.length,
       label + ': one printing height per layer - layer index and Z are 1:1');

    // Every layer isolates cleanly, over the whole real file.
    let totalIso = 0, multiZ = 0;
    for (let li = 0; li < parsed.layers.length; li++) {
      const got = G.movesInZWindow(parsed.moves, G.layerZWindow(parsed, li));
      if (heights(got).length !== 1) multiZ++;
      totalIso += got.length;
    }
    ok(multiZ === 0, label + ': every one of ' + parsed.layers.length +
       ' layers isolates to a single height');
    ok(totalIso === parsed.moves.length,
       label + ': the isolated layers partition all ' + parsed.moves.length + ' moves exactly');

    console.log('  ' + label + ': features = ' + parsed.features.map(f => f.name).join(', '));
  }

  // =========================================================================
  // tabletop.gcode.3mf - the three hand-verified measurements
  // =========================================================================
  const parsed = parsedOf['tabletop.gcode.3mf'];
  const si = parsed.moves.filter(m => m.feature === 'Support interface');
  ok(si.length > 0, 'tabletop: the Support interface feature is there to measure');

  // ---- (a) strand width ~= 0.61 mm ---------------------------------------
  const wMean = weighted(si, 'width');
  let wLo = Infinity, wHi = -Infinity;
  si.forEach(m => { wLo = Math.min(wLo, m.width); wHi = Math.max(wHi, m.width); });
  near(wMean, 0.61, 0.005,
       'tabletop: support-interface strand width is the hand-verified 0.61 mm');
  ok(wHi - wLo < 0.01,
     'tabletop: that width is one consistent strand, not an average of a spread (' +
     wLo.toFixed(4) + ' .. ' + wHi.toFixed(4) + ' mm)');
  console.log('    strand width: ' + wMean.toFixed(4) + ' mm length-weighted over ' +
              si.reduce((a, m) => a + m.length, 0).toFixed(0) + ' mm of path');

  // ---- (b) exactly 2 stacked layers, opposite directions -----------------
  const siZ = heights(si);
  ok(siZ.length === 2,
     'tabletop: the support interface is EXACTLY 2 layers (got ' + siZ.length + ')');

  // Stacked: consecutive layers, one layer height apart.
  const lower = si.filter(m => Math.abs(m.z - siZ[0]) <= G.Z_EPS);
  const upper = si.filter(m => Math.abs(m.z - siZ[1]) <= G.Z_EPS);
  const hLower = weighted(lower, 'height');
  // Bambu Studio rounds its own `; LAYER_HEIGHT:` tag - this file writes 0.3,
  // 0.299999 AND 0.300001 for what is a uniform 0.3 mm Z step. So the declared
  // height and the measured Z step legitimately disagree at the 1e-6 level, and
  // TAG_ROUNDING is that, not slack: a 0.3 step against a 0.6 height still
  // fails this by 300x. Only a real slice shows this; the synthetic fixture
  // writes exact values and never would.
  const TAG_ROUNDING = 2e-5;
  near(siZ[1] - siZ[0], hLower, TAG_ROUNDING,
       'tabletop: the two interface layers are STACKED - one layer height apart');
  const liLo = G.layerIndexAtZ(parsed, siZ[0]);
  const liHi = G.layerIndexAtZ(parsed, siZ[1]);
  ok(liHi === liLo + 1, 'tabletop: they are consecutive layers (' + liLo + ', ' + liHi + ')');

  // Opposite directions: the two rasters are 90 degrees apart.
  const aLo = dominantAngle(lower), aHi = dominantAngle(upper);
  let delta = Math.abs(aHi.angle - aLo.angle) % 180;
  if (delta > 90) delta = 180 - delta;
  near(delta, 90, 1e-9,
       'tabletop: the two zigzag layers run in OPPOSITE directions (' +
       aLo.angle + ' deg then ' + aHi.angle + ' deg)');
  // and each layer really is one dominant zigzag, not a mix.
  [[lower, aLo, 'lower'], [upper, aHi, 'upper']].forEach(([ms, dom, which]) => {
    const L = ms.reduce((a, m) => a + m.length, 0);
    ok(dom.length / L > 0.9,
       'tabletop: the ' + which + ' interface layer is one dominant zigzag (' +
       (100 * dom.length / L).toFixed(1) + '% of its path at ' + dom.angle + ' deg)');
  });

  // ---- (c) no separate border / perimeter feature ------------------------
  const names = parsed.features.map(f => f.name);
  ok(!names.some(n => /border|perimeter|contour|brim|raft|loop/i.test(n)),
     'tabletop: NO separate border / perimeter feature exists at all (' + names.length +
     ' features, none named one)');

  // The edge is branch-tip convergence, not a contour. A contour round this
  // outline would be one long unbroken run of off-axis moves; what is actually
  // there is isolated single moves - the zigzag's own turnarounds.
  [[lower, aLo, 'lower'], [upper, aHi, 'upper']].forEach(([ms, dom, which]) => {
    const off = ms.filter(m => {
      const a = ((m.angle * 180 / Math.PI) % 180 + 180) % 180;
      return Math.abs(((a - dom.angle + 90) % 180) - 90) > 15;
    });
    const idx = off.map(m => m.index).sort((a, b) => a - b);
    let best = 0, run = 0;
    for (let i = 0; i < idx.length; i++) { run = (i && idx[i] === idx[i - 1] + 1) ? run + 1 : 1; if (run > best) best = run; }
    ok(best <= 2,
       'tabletop: the ' + which + ' interface edge has no contour run - longest chain of ' +
       'off-axis moves is ' + best + ', so those are zigzag turnarounds, not a border');
  });

  // Branch-tip convergence: the support below is many short moves over the same
  // footprint that the interface covers in few long strokes. That is tips
  // converging into a sheet, and it is why no border is needed.
  const supTop = (() => {
    const sup = parsed.moves.filter(m => m.feature === 'Support');
    const zs = heights(sup);
    return sup.filter(m => Math.abs(m.z - zs[zs.length - 1]) <= G.Z_EPS);
  })();
  ok(supTop.length > 0, 'tabletop: the support below the interface is there to compare');
  const meanLen = ms => ms.reduce((a, m) => a + m.length, 0) / ms.length;
  ok(meanLen(supTop) < meanLen(lower),
     'tabletop: the support top layer is many SHORT moves (' + meanLen(supTop).toFixed(3) +
     ' mm mean) feeding the interface\'s LONG strokes (' + meanLen(lower).toFixed(3) +
     ' mm mean) - branch tips converging, not a contour');

  const bbox = ms => {
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    ms.forEach(m => {
      x0 = Math.min(x0, m.x0, m.x1); x1 = Math.max(x1, m.x0, m.x1);
      y0 = Math.min(y0, m.y0, m.y1); y1 = Math.max(y1, m.y0, m.y1);
    });
    return [x1 - x0, y1 - y0];
  };
  const bs = bbox(supTop), bi = bbox(lower);
  ok(Math.abs(bs[0] - bi[0]) < 1.0 && Math.abs(bs[1] - bi[1]) < 1.0,
     'tabletop: support top and interface share one footprint (' +
     bs.map(v => v.toFixed(1)).join('x') + ' vs ' + bi.map(v => v.toFixed(1)).join('x') +
     ' mm) - the interface caps the branches, it does not outline them');

  // ---- the isolation claim, on the real file ----------------------------
  // The whole reason for the Z filter: this feature has 2 layers, and one of
  // them must come out ALONE.
  const isoLower = G.movesInZWindow(si, G.zWindowAround(siZ[0], 0));
  ok(isoLower.length === lower.length && isoLower.length < si.length,
     'tabletop: one interface layer isolates from the other (' + isoLower.length +
     ' of ' + si.length + ' interface moves)');
  ok(heights(isoLower).length === 1,
     'tabletop: the isolated interface layer is at one height only');

  // And a whole-layer-at-one-Z extraction of it is exportable.
  const wholeLayer = G.movesAtZ(parsed, siZ[0]);
  ok(wholeLayer.length >= lower.length,
     'tabletop: the whole layer at that Z includes the interface and anything beside it (' +
     wholeLayer.length + ' moves, features: ' +
     Array.from(new Set(wholeLayer.map(m => m.feature))).join(', ') + ')');
  const st = shellStats(G.buildLineGeometry(wholeLayer).positions);
  ok(st.open === 0, 'tabletop: that isolated real layer exports with NO open edges');
  ok(st.degen === 0, 'tabletop: that isolated real layer has no degenerate triangles');
  ok(st.vol > 0, 'tabletop: that isolated real layer has positive signed volume');
  console.log('    isolated layer at Z ' + siZ[0].toFixed(3) + ': ' + wholeLayer.length +
              ' beads, ' + st.tris + ' triangles, volume ' + st.vol.toFixed(3) + ' mm^3');

  // =========================================================================
  // supportwithinsupport.gcode.3mf - the second real file
  // =========================================================================
  const p2 = parsedOf['supportwithinsupport.gcode.3mf'];
  ok(p2.features.some(f => f.name === 'Support interface'),
     'supportwithinsupport: it has a Support interface to read');
  ok(p2.features.some(f => f.name === 'Floating vertical shell'),
     'supportwithinsupport: it exercises Floating vertical shell, which tabletop does not');
  // Every feature this real file names is one the colour table knows, so a
  // Z-isolated layer of it reads the same here as in the reference tool.
  const unknown = p2.features.map(f => f.name).filter(n => G.colorForFeature(n) === G.OTHER_COLOR);
  ok(unknown.length === 0,
     'supportwithinsupport: every feature it names has a colour (' +
     (unknown.length ? unknown.join(', ') : 'all known') + ')');
  const unknown1 = parsed.features.map(f => f.name).filter(n => G.colorForFeature(n) === G.OTHER_COLOR);
  ok(unknown1.length === 0,
     'tabletop: every feature it names has a colour (' +
     (unknown1.length ? unknown1.join(', ') : 'all known') + ')');
}

(async () => {
  await overFixture();
  await extractOneLayer();
  await realFiles();
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  if (fail) { failures.forEach(f => console.log('  - ' + f)); process.exit(1); }
})().catch(e => { console.error(e); process.exit(1); });
