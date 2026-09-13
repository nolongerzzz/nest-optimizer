#!/usr/bin/env node
// Headless self-test for app-sculpt.js (vertex adjacency + global Laplacian).
//
//   node tools/sculpt_selftest.js
//
// Loads the shipped file with vm so the browser file stays free of any node
// idiom (no module.exports, no require) -- classic script tag, as the app
// needs. Prints real before/after numbers, not pass/fail booleans.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const ctx = { Math, Map, Set, console, Float32Array, Float64Array, Int32Array, Uint8Array, isFinite };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'app-sculpt.js'), 'utf8'), ctx, { filename: 'app-sculpt.js' });

const { NSO_buildAdjacency, NSO_smoothGlobal, NSO_sculptMetrics, NSO_adjacencyToRaw } = ctx;

/* ---------- fixture builders ---------- */

// Icosphere, radius r, `sub` subdivisions. Watertight, genus 0, all-triangle.
function icosphere(r, sub) {
  const t = (1 + Math.sqrt(5)) / 2;
  let verts = [
    [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0],
    [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
    [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]
  ];
  let faces = [
    [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
    [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
    [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]
  ];
  for (let s = 0; s < sub; s++) {
    const mid = new Map();
    const nf = [];
    const midpoint = (a, b) => {
      const k = a < b ? a + '_' + b : b + '_' + a;
      if (mid.has(k)) return mid.get(k);
      const A = verts[a], B = verts[b];
      const id = verts.length;
      verts.push([(A[0] + B[0]) / 2, (A[1] + B[1]) / 2, (A[2] + B[2]) / 2]);
      mid.set(k, id);
      return id;
    };
    for (const [a, b, c] of faces) {
      const ab = midpoint(a, b), bc = midpoint(b, c), ca = midpoint(c, a);
      nf.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]);
    }
    faces = nf;
  }
  const out = [];
  for (const f of faces) {
    for (const i of f) {
      const v = verts[i];
      const L = Math.hypot(v[0], v[1], v[2]);
      out.push(v[0] / L * r, v[1] / L * r, v[2] / L * r);
    }
  }
  return new Float32Array(out);
}

// Deterministic radial noise on a sphere soup: same vertex position always
// gets the same displacement, so the mesh stays watertight.
function noisyRadial(soup, amp) {
  const out = new Float32Array(soup.length);
  const hash = (x, y, z) => {
    let h = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
    return h - Math.floor(h);
  };
  for (let i = 0; i < soup.length; i += 3) {
    const x = soup[i], y = soup[i + 1], z = soup[i + 2];
    const L = Math.hypot(x, y, z) || 1;
    // quantize the hash input so shared vertices agree bit for bit
    const q = v => Math.round(v * 1e4) / 1e4;
    const s = 1 + (hash(q(x), q(y), q(z)) - 0.5) * 2 * amp;
    out[i] = x * s; out[i + 1] = y * s; out[i + 2] = z * s;
  }
  return out;
}

// Axis-aligned box, tessellated nx*ny*nz. Grid coordinates are computed the
// same way on every face, so seam vertices coincide exactly and the result
// is watertight before any welding.
function boxGrid(sx, sy, sz, nx, ny, nz, omit) {
  omit = omit || [];
  const skip = n => omit.indexOf(n) >= 0;
  const ax = sx / 2, ay = sy / 2, az = sz / 2;
  const gx = i => -ax + (2 * ax) * i / nx;
  const gy = i => -ay + (2 * ay) * i / ny;
  const gz = i => -az + (2 * az) * i / nz;
  const out = [];
  const quad = (p0, p1, p2, p3) => { out.push(...p0, ...p1, ...p2, ...p0, ...p2, ...p3); };
  for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) {
    if (!skip('+Z')) quad([gx(i), gy(j), az], [gx(i + 1), gy(j), az], [gx(i + 1), gy(j + 1), az], [gx(i), gy(j + 1), az]);
    if (!skip('-Z')) quad([gx(i), gy(j), -az], [gx(i), gy(j + 1), -az], [gx(i + 1), gy(j + 1), -az], [gx(i + 1), gy(j), -az]);
  }
  for (let i = 0; i < nx; i++) for (let k = 0; k < nz; k++) {
    if (!skip('-Y')) quad([gx(i), -ay, gz(k)], [gx(i + 1), -ay, gz(k)], [gx(i + 1), -ay, gz(k + 1)], [gx(i), -ay, gz(k + 1)]);
    if (!skip('+Y')) quad([gx(i), ay, gz(k)], [gx(i), ay, gz(k + 1)], [gx(i + 1), ay, gz(k + 1)], [gx(i + 1), ay, gz(k)]);
  }
  for (let j = 0; j < ny; j++) for (let k = 0; k < nz; k++) {
    if (!skip('+X')) quad([ax, gy(j), gz(k)], [ax, gy(j + 1), gz(k)], [ax, gy(j + 1), gz(k + 1)], [ax, gy(j), gz(k + 1)]);
    if (!skip('-X')) quad([-ax, gy(j), gz(k)], [-ax, gy(j), gz(k + 1)], [-ax, gy(j + 1), gz(k + 1)], [-ax, gy(j + 1), gz(k)]);
  }
  return new Float32Array(out);
}

// Hollow tube: `seg` segments round, `nz` divisions up the wall, flat annulus
// caps top and bottom. Watertight, genus 1. nz is the knob the resolution
// study below turns.
function tube(rOut, rIn, h, seg, nz) {
  const out = [];
  const quad = (p0, p1, p2, p3) => { out.push(...p0, ...p1, ...p2, ...p0, ...p2, ...p3); };
  const P = (r, i, z) => { const a = 2 * Math.PI * (i % seg) / seg; return [r * Math.cos(a), r * Math.sin(a), z]; };
  const gz = k => -h / 2 + h * k / nz;
  for (let i = 0; i < seg; i++) {
    for (let k = 0; k < nz; k++) {
      quad(P(rOut, i, gz(k)), P(rOut, i + 1, gz(k)), P(rOut, i + 1, gz(k + 1)), P(rOut, i, gz(k + 1)));  // outer wall, +r out
      quad(P(rIn, i, gz(k)), P(rIn, i, gz(k + 1)), P(rIn, i + 1, gz(k + 1)), P(rIn, i + 1, gz(k)));      // inner wall, -r out
    }
    quad(P(rOut, i, h / 2), P(rOut, i + 1, h / 2), P(rIn, i + 1, h / 2), P(rIn, i, h / 2));              // top annulus, +Z out
    quad(P(rIn, i, -h / 2), P(rIn, i + 1, -h / 2), P(rOut, i + 1, -h / 2), P(rOut, i, -h / 2));          // bottom annulus, -Z out
  }
  return new Float32Array(out);
}

function loadSTL(rel) {
  const data = fs.readFileSync(path.join(ROOT, rel));
  const head = data.slice(0, 200).toString('latin1').toLowerCase();
  if (head.startsWith('solid') && head.includes('facet')) {
    const out = [];
    for (const line of data.toString('utf8').split('\n')) {
      const p = line.trim().split(/\s+/);
      if (p[0] === 'vertex') out.push(+p[1], +p[2], +p[3]);
    }
    return new Float32Array(out);
  }
  const n = data.readUInt32LE(80);
  const out = new Float32Array(n * 9);
  let off = 84;
  for (let t = 0; t < n; t++) {
    for (let k = 0; k < 9; k++) out[t * 9 + k] = data.readFloatLE(off + 12 + k * 4);
    off += 50;
  }
  return out;
}

/* ---------- reporting ---------- */

const f = (v, d = 3) => (typeof v === 'number' ? v.toFixed(d) : String(v));
const bb = m => `${f(m.bbox.size[0])} x ${f(m.bbox.size[1])} x ${f(m.bbox.size[2])}`;

function adjLine(adj) {
  const V = adj.vertCount, E = adj.edgeCount, F = adj.triCount;
  return `verts ${V}  edges ${E}  tris ${F}  open ${adj.openEdges}  nm ${adj.nmEdges}` +
    `  stackedDirs ${adj.stackedDirs}  V-E+F ${V - E + F}  weldTol ${adj.weldTol.toExponential(1)}` +
    `  welded ${adj.triIn * 3 - V} dup verts  dropped ${adj.droppedTris} slivers` +
    (adj.isolated ? `  isolated ${adj.isolated}` : '');
}

function metricLine(tag, m) {
  return `  ${tag.padEnd(6)} bbox ${bb(m).padEnd(26)} vol ${f(m.volume, 4).padStart(12)}` +
    `  area ${f(m.area, 3).padStart(11)}  openPos ${m.openPos}  nmPos ${m.nmPos}` +
    `  degen ${m.degenerate}  minEdge ${m.minEdge.toExponential(2)}  watertight ${m.watertight ? 'yes' : 'NO'}`;
}

function sweep(name, soup, passSet, strength, opts) {
  opts = opts || {};
  console.log('\n=== ' + name + ' ===');
  const adj0 = NSO_buildAdjacency(soup, { tol: opts.tol });
  console.log('  adjacency: ' + adjLine(adj0));
  const base = NSO_sculptMetrics(NSO_adjacencyToRaw(adj0, adj0.pos), adj0);
  console.log(metricLine('before', base));
  const rows = [];
  for (const p of passSet) {
    const r = NSO_smoothGlobal(soup, { passes: p, strength, tol: opts.tol, pinBoundary: opts.pinBoundary });
    if (!r.ok) { console.log(`  passes ${p}: REFUSED - ${r.reason}`); continue; }
    const a = r.after;
    rows.push({ p, r, a });
    const volPct = 100 * (1 - Math.abs(a.volume) / Math.abs(base.volume || 1));
    console.log(`  passes ${String(p).padStart(3)} s=${strength}  bbox ${bb(a).padEnd(26)}` +
      ` vol ${f(a.volume, 4).padStart(12)} (-${f(volPct, 2).padStart(6)}%)` +
      ` area ${f(a.area, 2).padStart(10)}` +
      ` maxMove ${f(r.maxMove, 4).padStart(8)}` +
      ` open ${a.openPos} nm ${a.nmPos} degen ${a.degenerate}` +
      ` verts ${a.verts}/${base.verts} tris ${a.tris}/${base.tris}` +
      ` wt ${a.watertight ? 'yes' : 'NO'}`);
    if (opts.extra) console.log('        ' + opts.extra(r));
  }
  return { adj0, base, rows };
}

/* ---------- 0. adjacency unit checks ---------- */

console.log('########## 0. ADJACENCY ##########');
{
  const cube = loadSTL('fixtures/box-20mm.stl');
  const adj = NSO_buildAdjacency(cube);
  console.log('\n=== fixtures/box-20mm.stl (12-tri cube, soup of 36 loose verts) ===');
  console.log('  ' + adjLine(adj));
  console.log('  expect verts 8, edges 18, tris 12, V-E+F 2, open 0, nm 0');
  // neighbour ring of vertex 0
  const s = adj.nbrStart[0], e = adj.nbrStart[1];
  console.log('  vertex 0 at [' + [0, 1, 2].map(i => f(adj.pos[i])).join(', ') + '] has ' + (e - s) +
    ' neighbours: ' + Array.from(adj.nbrList.slice(s, e)).join(', '));
  let sym = true;
  for (let v = 0; v < adj.vertCount; v++) {
    for (let i = adj.nbrStart[v]; i < adj.nbrStart[v + 1]; i++) {
      const w = adj.nbrList[i];
      let back = false;
      for (let j = adj.nbrStart[w]; j < adj.nbrStart[w + 1]; j++) if (adj.nbrList[j] === v) back = true;
      if (!back) sym = false;
    }
  }
  console.log('  graph symmetric (every a->b has b->a): ' + sym);
}
{
  // The boundary flag has to find a real rim. Build one: a 20mm box with the
  // +Z face deleted, so exactly the 24 vertices round that opening are rim.
  const open = boxGrid(20, 20, 20, 6, 6, 6, ['+Z']);
  const adj = NSO_buildAdjacency(open);
  let nb = 0; for (let i = 0; i < adj.vertCount; i++) if (adj.boundary[i]) nb++;
  console.log('\n=== synthetic open box, +Z face deleted ===');
  console.log('  ' + adjLine(adj));
  console.log('  boundary vertices flagged: ' + nb + '  (expect 24 = the ring round a 6x6 opening)');
}
{
  // Branch A of the tolerance cap: fine detail is PERVASIVE, so it is the
  // piece's real feature scale and the strict minimum edge must protect it.
  // This is the wrapped-surface case NSO_weldEpsFor was written for.
  const fine = boxGrid(1, 1, 1, 40, 40, 40);   // every edge 0.025 mm
  const asked = 0.08;
  const capped = ctx.NSO_sculptWeldTol(fine, asked);
  const a1 = NSO_buildAdjacency(fine, { tol: asked });
  const a2 = NSO_buildAdjacency(fine, { tol: asked, rawTol: true });
  console.log('\n=== weld tolerance, branch A: pervasive fine detail ===');
  console.log('  1mm cube, all 0.025mm edges, caller asks 0.08');
  console.log('  cap returns ' + capped.toExponential(3) + ' (= shortest edge / 3)');
  console.log('  capped  : ' + adjLine(a1));
  console.log('  RAW 0.08: ' + adjLine(a2) + '   <- what the uncapped ask destroys');
}
{
  // Branch B: a handful of slivers must NOT set the tolerance for the whole
  // mesh. This is the bug found on the tape fixture -- 2 short edges out of
  // 98,586 dragged a strict-minimum cap to 5e-6 and reported 1402 open
  // edges on a mesh that is closed.
  const clean = boxGrid(20, 20, 20, 8, 8, 8);
  const poisoned = new Float32Array(clean.length + 9);
  poisoned.set(clean);
  // one needle triangle, 1.5e-5 long, parked well away from the box
  const o = clean.length;
  poisoned[o] = 100; poisoned[o + 1] = 100; poisoned[o + 2] = 100;
  poisoned[o + 3] = 100 + 1.5e-5; poisoned[o + 4] = 100; poisoned[o + 5] = 100;
  poisoned[o + 6] = 100; poisoned[o + 7] = 100 + 1.5e-5; poisoned[o + 8] = 100;
  console.log('\n=== weld tolerance, branch B: two slivers in a sound mesh ===');
  console.log('  20mm cube 8x8, plus ONE 1.5e-5 mm needle triangle far away');
  console.log('  strict-minimum cap would return ' + (1.5e-5 / 3).toExponential(3) +
    '; this cap returns ' + ctx.NSO_sculptWeldTol(poisoned, 1e-4).toExponential(3));
  console.log('  ' + adjLine(NSO_buildAdjacency(poisoned)));
  console.log('  (the needle welds to a single point and its triangle is dropped, leaving');
  console.log('   one edgeless vertex - that is the +1 in V-E+F 3, and it is reported as');
  console.log('   isolated=' + NSO_buildAdjacency(poisoned).isolated + ' rather than passed off as real geometry)');
}

/* ---------- 1. noisy sphere ---------- */

console.log('\n\n########## 1. FACETED / NOISY SPHERE ##########');
{
  const R = 10;
  const clean = icosphere(R, 3);
  const soup = noisyRadial(clean, 0.06);   // +/- 6% radial jitter
  const rough = tris => {
    const adj = NSO_buildAdjacency(tris);
    let s = 0, s2 = 0;
    for (let v = 0; v < adj.vertCount; v++) {
      const r = Math.hypot(adj.pos[v * 3], adj.pos[v * 3 + 1], adj.pos[v * 3 + 2]);
      s += r; s2 += r * r;
    }
    const n = adj.vertCount, mean = s / n;
    return { mean, sd: Math.sqrt(Math.max(0, s2 / n - mean * mean)) };
  };
  const r0 = rough(soup);
  console.log(`  radius before: mean ${f(r0.mean, 4)}  sd ${f(r0.sd, 4)}  (ideal sphere sd 0)`);
  sweep('noisy icosphere R=10, sub 3, +/-6% jitter', soup, [1, 2, 5, 10, 20, 50], 0.5, {
    extra: r => {
      const q = rough(r.tris);
      return `radius mean ${f(q.mean, 4)}  sd ${f(q.sd, 4)}  (sd ${f(100 * (1 - q.sd / r0.sd), 1)}% down)`;
    }
  });
}

/* ---------- 2. sharp box ---------- */

console.log('\n\n########## 2. SHARP-EDGED BOX ##########');
{
  const cube = loadSTL('fixtures/box-20mm.stl');
  sweep('20mm cube, 12 tris (8 vertices, all of them corners)', cube, [1, 2, 5, 10], 0.5);
  console.log('  NOTE: with 12 triangles every vertex IS a corner and every neighbour');
  console.log('        is another corner, so the whole box walks to its centroid.');
  console.log('        That is the algorithm on a mesh with no interior vertices,');
  console.log('        not a bug. Tessellation is what gives smoothing something to work with.');

  const tess = boxGrid(20, 20, 20, 8, 8, 8);
  const corner = tris => {
    // how far the sharpest original corner (10,10,10) has pulled in
    const adj = NSO_buildAdjacency(tris);
    let best = Infinity, bi = -1;
    for (let v = 0; v < adj.vertCount; v++) {
      const d = Math.hypot(adj.pos[v * 3] - 10, adj.pos[v * 3 + 1] - 10, adj.pos[v * 3 + 2] - 10);
      if (d < best) { best = d; bi = v; }
    }
    return best;
  };
  sweep('20mm cube, tessellated 8x8 per face', tess, [1, 2, 5, 10, 25, 50], 0.5, {
    extra: r => `corner (10,10,10) pulled in ${f(corner(r.tris), 4)} mm`
  });
  // A flat face has no curvature, so uniform Laplacian should leave its
  // interior vertices exactly where they are. Only the rim of the face,
  // which has neighbours on the next face round, is allowed to move.
  const adjT = NSO_buildAdjacency(tess);
  const r5 = NSO_smoothGlobal(tess, { passes: 5, strength: 0.5, adj: adjT });
  let inFace = 0, worst = 0;
  const moved5 = r5.tris;
  const seen = new Set();
  for (let t = 0; t < adjT.triCount; t++) {
    for (let k = 0; k < 3; k++) {
      const vId = adjT.tri[t * 3 + k];
      if (seen.has(vId)) continue;
      const x0 = adjT.pos[vId * 3], y0 = adjT.pos[vId * 3 + 1], z0 = adjT.pos[vId * 3 + 2];
      if (Math.abs(z0 - 10) < 1e-9 && Math.abs(x0) < 9.99 && Math.abs(y0) < 9.99) {
        seen.add(vId); inFace++;
        const d = Math.abs(moved5[t * 9 + k * 3 + 2] - 10);
        if (d > worst) worst = d;
      }
    }
  }
  console.log(`  face flatness after 5 passes: ${inFace} vertices started strictly inside the +Z face;`);
  console.log(`  the worst of them is now ${f(worst, 6)} mm off the z=10 plane`);
}

/* ---------- 3. thin feature ---------- */

console.log('\n\n########## 3. THIN / NARROW FEATURE ##########');
{
  const slab = boxGrid(40, 40, 1.5, 20, 20, 1);
  sweep('thin slab 40 x 40 x 1.5 (aspect 26.7:1)', slab, [1, 2, 5, 10, 25, 50, 100], 0.5, {
    extra: r => {
      const s = r.after.bbox.size, b = r.before.bbox.size;
      return `thickness ${f(s[2], 4)} of ${f(b[2], 3)} (${f(100 * s[2] / b[2], 1)}% left)` +
        `   span ${f(s[0], 3)} of ${f(b[0], 3)} (${f(100 * s[0] / b[0], 1)}% left)`;
    }
  });

  const tube = loadSTL('library/soften_test_03_thinwall_tube.stl');
  sweep('library/soften_test_03_thinwall_tube.stl (real thin-wall part)', tube, [1, 2, 5, 10, 25], 0.5, {
    extra: r => {
      const s = r.after.bbox.size, b = r.before.bbox.size;
      return `bbox shrink  x ${f(100 * (1 - s[0] / b[0]), 2)}%  y ${f(100 * (1 - s[1] / b[1]), 2)}%  z ${f(100 * (1 - s[2] / b[2]), 2)}%`;
    }
  });

  const star = loadSTL('library/soften_test_05_star_prism.stl');
  sweep('library/soften_test_05_star_prism.stl (sharp points)', star, [1, 2, 5, 10, 25], 0.5);
}

/* ---------- 4. strength sweep + gate ---------- */

console.log('\n\n########## 4. STRENGTH + GATE ##########');
{
  const slab = boxGrid(40, 40, 1.5, 20, 20, 1);
  console.log('\n=== strength at a fixed 10 passes, thin slab ===');
  for (const s of [0.1, 0.25, 0.5, 0.75, 1.0]) {
    const r = NSO_smoothGlobal(slab, { passes: 10, strength: s });
    if (!r.ok) { console.log(`  s=${s}: REFUSED - ${r.reason}`); continue; }
    console.log(`  s=${String(s).padEnd(5)} thickness ${f(r.after.bbox.size[2], 4)}` +
      `  vol ${f(r.after.volume, 3).padStart(10)} (-${f(100 * (1 - r.after.volume / r.before.volume), 2)}%)` +
      `  maxMove ${f(r.maxMove, 4)}  wt ${r.after.watertight ? 'yes' : 'NO'}`);
  }
  console.log('\n=== refusals (nothing swaps unless the numbers allow it) ===');
  for (const bad of [{ strength: 1.5 }, { strength: -0.2 }, { passes: -1 }]) {
    const r = NSO_smoothGlobal(slab, bad);
    console.log('  ' + JSON.stringify(bad).padEnd(20) + ' -> ok=' + r.ok + '  reason: ' + r.reason +
      '  tris identical to input: ' + (r.tris === slab));
  }
  const budget = NSO_smoothGlobal(slab, { passes: 50, strength: 0.5, maxVolumeChange: 0.05 });
  console.log('  maxVolumeChange 5%, 50 passes, slab  -> ok=' + budget.ok + '  reason: ' + budget.reason +
    '  tris identical to input: ' + (budget.tris === slab));
  // the same budget has to catch INFLATION, which a loss-only budget misses
  const bore = tube(11, 9, 25, 48, 8);
  const grow = NSO_smoothGlobal(bore, { passes: 1, strength: 0.5, maxVolumeChange: 0.05 });
  console.log('  maxVolumeChange 5%,  1 pass,  tube  -> ok=' + grow.ok + '  reason: ' + grow.reason +
    '  tris identical to input: ' + (grow.tris === bore));
  const ok0 = NSO_smoothGlobal(slab, { passes: 0 });
  console.log('  passes 0             -> ok=' + ok0.ok + '  moved ' + ok0.moved + ' verts  (weld-only round trip)');
}

/* ---------- 5. open mesh, boundary pin ---------- */

console.log('\n\n########## 5. OPEN MESH / BOUNDARY PIN ##########');
{
  // fixtures/box_open.stl is "open" in the tray sense but topologically CLOSED
  // (0 odd edges by tools/stl_watertight_check.py), so it does not exercise
  // the rim at all. A box with one face genuinely deleted does.
  const closedTray = loadSTL('fixtures/box_open.stl');
  const ct = NSO_buildAdjacency(closedTray);
  console.log('\n  fixtures/box_open.stl for reference: ' + adjLine(ct) + '  -> closed shell, no rim');

  const lid = boxGrid(20, 20, 20, 6, 6, 6, ['+Z']);
  const la = NSO_buildAdjacency(lid);
  let nb = 0; for (let i = 0; i < la.vertCount; i++) if (la.boundary[i]) nb++;
  console.log('  synthetic open box (+Z face deleted): ' + adjLine(la) + '  boundary verts ' + nb);

  const rim = (tris, adj) => {
    let minZ = Infinity, maxZ = -Infinity, span = 0;
    for (let t = 0; t < adj.triCount; t++) for (let k = 0; k < 3; k++) {
      const v = adj.tri[t * 3 + k];
      if (!adj.boundary[v]) continue;
      const z = tris[t * 9 + k * 3 + 2];
      const x = tris[t * 9 + k * 3];
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
      if (Math.abs(x) > span) span = Math.abs(x);
    }
    return `rim z ${f(minZ, 4)}..${f(maxZ, 4)}  rim half-span ${f(span, 4)}`;
  };
  for (const pin of [true, false]) {
    console.log(`\n=== open box, pinBoundary ${pin ? 'TRUE (default)' : 'FALSE'} ===`);
    console.log('  before: ' + rim(NSO_adjacencyToRaw(la, la.pos), la) + '   (rim starts at z 10.0000, half-span 10.0000)');
    for (const p of [1, 5, 20]) {
      const r = NSO_smoothGlobal(lid, { passes: p, strength: 0.5, pinBoundary: pin, adj: la });
      if (!r.ok) { console.log(`  passes ${p}: REFUSED - ${r.reason}`); continue; }
      console.log(`  passes ${String(p).padStart(2)}  ${rim(r.tris, la)}` +
        `  bbox ${bb(r.after)}  openPos ${r.after.openPos}  maxMove ${f(r.maxMove, 4)}`);
    }
  }
  console.log('\n  (volume/watertight are meaningless on an open shell and are not gated here;');
  console.log('   the gate still refuses anything that RAISES the open-edge count.)');
}

/* ---------- 6. inconsistent winding ---------- */

console.log('\n\n########## 6. WINDING CHECK ##########');
{
  // The same 20mm cube with two of its six faces wound backwards. Every edge
  // still pairs, so undirected counting calls it watertight; the directed
  // count is the only thing that sees it.
  const good = boxGrid(20, 20, 20, 2, 2, 2);
  const bad = new Float32Array(good);
  for (let t = 0; t < bad.length / 9; t++) {
    const o = t * 9;
    if (Math.abs(bad[o + 1] - 10) < 1e-9 && Math.abs(bad[o + 4] - 10) < 1e-9 && Math.abs(bad[o + 7] - 10) < 1e-9) {
      for (let k = 0; k < 3; k++) { const s2 = bad[o + 3 + k]; bad[o + 3 + k] = bad[o + 6 + k]; bad[o + 6 + k] = s2; }
    }
  }
  for (const [tag, soup] of [['all faces correct', good], ['+Y face flipped', bad]]) {
    const adj = NSO_buildAdjacency(soup);
    const m = NSO_sculptMetrics(NSO_adjacencyToRaw(adj, adj.pos), adj);
    console.log(`\n  ${tag}`);
    console.log('  ' + adjLine(adj));
    console.log(metricLine('metrics', m));
    const r = NSO_smoothGlobal(soup, { passes: 2, strength: 0.5 });
    console.log('  smooth ok=' + r.ok + (r.warn ? '  warn: ' + r.warn : '  no warning'));
  }
  console.log('\n  Both pass the undirected edge test with 0 open / 0 non-manifold.');
  console.log('  Only stackedDirs and the volume separate them.');
}


/* ---------- 7. what actually drives the collapse ---------- */

console.log('\n\n########## 7. COLLAPSE vs TESSELLATION (the real finding) ##########');
{
  console.log('\n  Same physical part - 22/18 mm tube, 25 mm tall, 1 mm axial wall pitch');
  console.log('  is NOT what changes below. Only the number of divisions up the wall is.');
  console.log('  If Laplacian collapse were driven by physical thinness these rows would agree.\n');
  console.log(`  analytic solid volume pi*(11^2-9^2)*25 = ${f(Math.PI * (121 - 81) * 25, 3)}\n`);
  console.log('  nz   verts  stkDirs      vol   1-pass vol     5-pass vol   height 1   height 5');
  for (const nz of [1, 2, 4, 8, 16]) {
    const t = tube(11, 9, 25, 48, nz);
    const adj = NSO_buildAdjacency(t);
    const b = NSO_sculptMetrics(NSO_adjacencyToRaw(adj, adj.pos), adj);
    const r1 = NSO_smoothGlobal(t, { passes: 1, strength: 0.5, adj });
    const r5 = NSO_smoothGlobal(t, { passes: 5, strength: 0.5, adj });
    const d = r => `${f(r.after.volume, 1)} (${r.after.volume >= b.volume ? '+' : ''}${f(100 * (r.after.volume / b.volume - 1), 1)}%)`;
    console.log(`  ${String(nz).padStart(2)}  ${String(adj.vertCount).padStart(6)}  ${String(adj.stackedDirs).padStart(7)}` +
      `  ${f(b.volume, 1).padStart(7)}  ${d(r1).padStart(16)}  ${d(r5).padStart(16)}` +
      `  ${f(r1.after.bbox.size[2], 2).padStart(8)}  ${f(r5.after.bbox.size[2], 2).padStart(8)}`);
  }
  console.log('\n  The part is identically thin in every row. The behaviour is not.');
  console.log('  What changes is how many neighbour hops separate a vertex from geometry');
  console.log('  on the far side of the thin section. At nz=1 every vertex is a corner,');
  console.log('  its neighbour average sits across the 25 mm gap, and the part is gone in');
  console.log('  5 passes. By nz=8 the wall carries interior vertices whose neighbours are');
  console.log('  their own flat wall, the height survives - and the volume GROWS, because');
  console.log('  the bore is concave from the solid and smoothing pushes its wall into the');
  console.log('  hole. Shrinkage is not a law; it is what happens on convex outer surfaces.');
}

/* ---------- 8. flat stays flat, and how far the rim reaches ---------- */

console.log('\n\n########## 8. DIFFUSION REACH ON A FLAT FACE ##########');
{
  const tess = boxGrid(20, 20, 20, 24, 24, 24);
  const adj = NSO_buildAdjacency(tess);
  // ring distance from the nearest sharp edge, in graph hops, for +Z face verts
  const ring = new Int32Array(adj.vertCount).fill(-1);
  const q = [];
  for (let v = 0; v < adj.vertCount; v++) {
    const x = adj.pos[v * 3], y = adj.pos[v * 3 + 1], z = adj.pos[v * 3 + 2];
    const onEdge = [Math.abs(Math.abs(x) - 10) < 1e-9, Math.abs(Math.abs(y) - 10) < 1e-9, Math.abs(Math.abs(z) - 10) < 1e-9]
      .filter(Boolean).length >= 2;
    if (onEdge) { ring[v] = 0; q.push(v); }
  }
  for (let h = 0; h < q.length; h++) {
    const v = q[h];
    for (let i = adj.nbrStart[v]; i < adj.nbrStart[v + 1]; i++) {
      const w = adj.nbrList[i];
      if (ring[w] < 0) { ring[w] = ring[v] + 1; q.push(w); }
    }
  }
  console.log('\n  20mm cube tessellated 24x24 per face. Vertices are bucketed by how many');
  console.log('  graph hops they sit from the nearest sharp edge of the box.\n');
  console.log('  passes   max move at hop 1     hop 3      hop 5      hop 8     hop 11');
  for (const p of [1, 3, 5, 8, 11]) {
    const r = NSO_smoothGlobal(tess, { passes: p, strength: 0.5, adj });
    const worst = {};
    for (let t = 0; t < adj.triCount; t++) for (let k = 0; k < 3; k++) {
      const v = adj.tri[t * 3 + k], hop = ring[v];
      const d = Math.hypot(r.tris[t * 9 + k * 3] - adj.pos[v * 3],
                           r.tris[t * 9 + k * 3 + 1] - adj.pos[v * 3 + 1],
                           r.tris[t * 9 + k * 3 + 2] - adj.pos[v * 3 + 2]);
      if (!(hop in worst) || d > worst[hop]) worst[hop] = d;
    }
    const cell = h => (worst[h] === undefined ? '   -   ' : worst[h].toExponential(2));
    console.log(`  ${String(p).padStart(6)}   ${cell(1).padStart(15)}  ${cell(3).padStart(9)}` +
      `  ${cell(5).padStart(9)}  ${cell(8).padStart(9)}  ${cell(11).padStart(9)}`);
  }
  console.log('\n  A pass reaches exactly one hop. Anything further from a sharp edge than');
  console.log('  the pass count has not moved at all (0e+0), so a flat face stays flat');
  console.log('  in its interior - the rounding is a rim effect that eats inward one');
  console.log('  ring per pass. That is the whole reason pass count, not strength, is');
  console.log('  the parameter that decides how much of a part global smoothing touches.');
}

/* ---------- 9. cost on a real part ---------- */

console.log('\n\n########## 9. COST ##########');
{
  const big = loadSTL('fixtures/tape_on-edge-single-B101_rounded_v8_FINAL.stl');
  let t0 = Date.now();
  const adj = NSO_buildAdjacency(big);
  const tAdj = Date.now() - t0;
  console.log('\n  fixtures/tape_on-edge-single-B101_rounded_v8_FINAL.stl');
  console.log('  ' + adjLine(adj));
  t0 = Date.now();
  const r = NSO_smoothGlobal(big, { passes: 10, strength: 0.5, adj });
  const tSm = Date.now() - t0;
  console.log(`  adjacency build ${tAdj} ms for ${adj.triIn} tris; 10 passes + metrics ${tSm} ms`);
  console.log(metricLine('before', r.before));
  console.log(metricLine('after', r.after));
}


/* ---------- 10. smoothing can ADD volume ---------- */

console.log('\n\n########## 10. CONCAVE SURFACES GAIN MATERIAL ##########');
{
  // Two disjoint shells in one file: a thin-walled tray (25 mm cavity) and a
  // lid slab. Split them so the two directions do not hide inside one total.
  const soup = loadSTL('library/box_closed.stl');
  const adj = NSO_buildAdjacency(soup);
  const comp = new Int32Array(adj.vertCount).fill(-1);
  let nc = 0;
  for (let v = 0; v < adj.vertCount; v++) {
    if (comp[v] >= 0) continue;
    const q = [v]; comp[v] = nc;
    for (let h = 0; h < q.length; h++) {
      for (let i = adj.nbrStart[q[h]]; i < adj.nbrStart[q[h] + 1]; i++) {
        const w = adj.nbrList[i];
        if (comp[w] < 0) { comp[w] = nc; q.push(w); }
      }
    }
    nc++;
  }
  const shellVols = tris => {
    const v = new Array(nc).fill(0);
    for (let q = 0; q < adj.triCount; q++) {
      const c = comp[adj.tri[q * 3]], o = q * 9;
      const a = [tris[o], tris[o + 1], tris[o + 2]];
      const b = [tris[o + 3], tris[o + 4], tris[o + 5]];
      const d = [tris[o + 6], tris[o + 7], tris[o + 8]];
      v[c] += (a[0] * (b[1] * d[2] - b[2] * d[1]) - a[1] * (b[0] * d[2] - b[2] * d[0]) + a[2] * (b[0] * d[1] - b[1] * d[0])) / 6;
    }
    return v;
  };
  console.log('\n  library/box_closed.stl  ' + adjLine(adj));
  console.log('  ' + nc + ' disjoint shells: a hollow tray and a lid slab.\n');
  const b = shellVols(NSO_adjacencyToRaw(adj, adj.pos));
  console.log('  passes    tray shell            lid shell            total');
  console.log(`  ${'before'.padStart(6)}  ${f(b[0], 1).padStart(10)}            ${f(b[1], 1).padStart(9)}         ${f(b[0] + b[1], 1).padStart(10)}`);
  for (const p of [1, 2, 5]) {
    const r = NSO_smoothGlobal(soup, { passes: p, strength: 0.5, adj });
    const v = shellVols(r.tris);
    const pc = (x, y) => `(${x >= y ? '+' : ''}${f(100 * (x / y - 1), 1)}%)`;
    console.log(`  ${String(p).padStart(6)}  ${f(v[0], 1).padStart(10)} ${pc(v[0], b[0]).padEnd(10)}  ${f(v[1], 1).padStart(9)} ${pc(v[1], b[1]).padEnd(10)}  ${f(v[0] + v[1], 1).padStart(10)}`);
  }
  console.log('\n  The tray more than DOUBLES in one pass. Its outer skin shrinks like');
  console.log('  everything else, but its 25 mm cavity is concave from the solid, so the');
  console.log('  cavity wall is driven into the void and the box fills in. Meanwhile the');
  console.log('  8-vertex lid collapses to nothing. Both happen in the same pass.');
  console.log('  This is why the optional volume budget is maxVolumeChange (two-sided)');
  console.log('  and not a shrinkage budget: a part being filled in passes a loss-only test.');
}
