#!/usr/bin/env node
// Headless self-test for nso_support_beacons.js: the beacon grid sampled from
// below, and detectOverhangs' wrapper over it.
//
//   node tools/nso_support_beacons_test.js      exit 0 = every gate held
//
// Every fixture is built here so the expected cells are countable by hand.
// Loads the shipped files with vm, in index.html's own order, like the other
// support suites.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const { readSTL } = require('./nso_stl_io.js');
const pace = require('./nso_pace.js');

const ctx = {
  Math, Map, Set, console, Array, Object, Number, String, JSON, isFinite,
  Float32Array, Float64Array, Int32Array, Uint32Array, Uint8Array, ArrayBuffer
};
vm.createContext(ctx);
for (const f of ['nso_thickness.js', 'nso_seat_surface.js', 'app-sculpt.js',
                 'app-extend.js', 'nso_support_beacons.js', 'nso_support_aim.js']) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
}
const SB = ctx.NSO_SupportBeacons;
const SA = ctx.NSO_SupportAim;

let pass = 0, fail = 0;
const FAILS = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok    ' + name + (detail ? '   ' + detail : '')); }
  else { fail++; FAILS.push(name); console.log('  FAIL  ' + name + (detail ? '   ' + detail : '')); }
}
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const kinds = d => {
  const k = {};
  for (const b of d.beacons) k[b.need.kind] = (k[b.need.kind] || 0) + 1;
  return JSON.stringify(k);
};
const centre = (g, i, j) => [g.origin[0] + (i + 0.5) * g.pitch, g.origin[1] + (j + 0.5) * g.pitch];

/* ---- shapes ------------------------------------------------------------- */

function box(lo, hi) {
  const v = [[lo[0], lo[1], lo[2]], [hi[0], lo[1], lo[2]], [hi[0], hi[1], lo[2]], [lo[0], hi[1], lo[2]],
             [lo[0], lo[1], hi[2]], [hi[0], lo[1], hi[2]], [hi[0], hi[1], hi[2]], [lo[0], hi[1], hi[2]]];
  const f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4],
             [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  const out = [];
  for (const t of f) for (const i of t) out.push(...v[i]);
  return out;
}
const soupOf = (...parts) => new Float32Array([].concat(...parts));

/* A closed box whose every face is cut into n x n quads (2n^2 triangles a
   face), then mapped through xf. Each grid point is computed from its own
   (i, j, k) alone, so two faces sharing an edge share its points bit for bit
   and the subdivided box stays watertight. */
function subdividedBox(size, n, xf) {
  const P = (i, j, k) => xf([size[0] * i / n, size[1] * j / n, size[2] * k / n]);
  const out = [];
  const quad = (a, b, c, d) => out.push(...a, ...b, ...c, ...a, ...c, ...d);
  for (let u = 0; u < n; u++) for (let v = 0; v < n; v++) {
    quad(P(u, v, 0), P(u, v + 1, 0), P(u + 1, v + 1, 0), P(u + 1, v, 0));      /* -z */
    quad(P(u, v, n), P(u + 1, v, n), P(u + 1, v + 1, n), P(u, v + 1, n));      /* +z */
    quad(P(u, 0, v), P(u + 1, 0, v), P(u + 1, 0, v + 1), P(u, 0, v + 1));      /* -y */
    quad(P(u, n, v), P(u, n, v + 1), P(u + 1, n, v + 1), P(u + 1, n, v));      /* +y */
    quad(P(0, u, v), P(0, u, v + 1), P(0, u + 1, v + 1), P(0, u + 1, v));      /* -x */
    quad(P(n, u, v), P(n, u + 1, v), P(n, u + 1, v + 1), P(n, u, v + 1));      /* +x */
  }
  return new Float32Array(out);
}

/* THE TILTED BOX. 40 x 30 x 10, turned 30 deg about y so its underside rises
   towards +x at 30 deg off the plate, its lowest edge (x = 0) on the plate.
   The underside's plan footprint is x 0 .. 40 cos 30, y 0 .. 30. */
const TILT = 30 * Math.PI / 180;
const tiltXf = p => [p[0] * Math.cos(TILT) - p[2] * Math.sin(TILT), p[1],
                     p[0] * Math.sin(TILT) + p[2] * Math.cos(TILT)];
const tiltedBox = n => subdividedBox([40, 30, 10], n, tiltXf);

/* nso_support_tree_test.js's SHELF: a 12 x 10 arm at z = 16 off a post. */
const SHELF = soupOf(box([0, 0, 0], [10, 10, 20]), box([10, 0, 16], [22, 10, 20]));

/* A slab on two pillars, `span` mm of air between them. */
const bridge = span => soupOf(box([0, 0, 0], [5, 10, 10]), box([5 + span, 0, 0], [10 + span, 10, 10]),
                              box([0, 0, 10], [10 + span, 10, 13]));

/* tools/nso_curved_branch_probe.js's mushroom: a 12 x 12 cap on a 4 x 4 stem,
   the cap's underside tessellated in 1 mm squares with the stem's square left
   out. And the plain two-box version, cap flush on the stem. */
function arm(x0, x1, y0, y1, z0, z1, cell, holes) {
  const out = [];
  const inHole = (x, y) => holes.some(h => x >= h[0] - 1e-9 && x + cell <= h[1] + 1e-9 &&
                                           y >= h[2] - 1e-9 && y + cell <= h[3] + 1e-9);
  for (let x = x0; x < x1 - 1e-9; x += cell) {
    for (let y = y0; y < y1 - 1e-9; y += cell) {
      if (inHole(x, y)) continue;
      const a = [x, y, z0], b = [x + cell, y, z0], c = [x + cell, y + cell, z0], d = [x, y + cell, z0];
      out.push(...a, ...c, ...b, ...a, ...d, ...c);
    }
  }
  return out.concat(box([x0, y0, z0], [x1, y1, z1]).slice(6 * 9));
}
const MUSHROOM = soupOf(box([4, 4, 0], [8, 8, 20]), arm(0, 12, 0, 12, 20, 24, 1, [[4, 8, 4, 8]]));
const MUSHROOM_FLUSH = soupOf(box([4, 4, 0], [8, 8, 20]), box([0, 0, 20], [12, 12, 24]));

/* A threaded shank, generated: a cylinder whose radius follows a symmetric
   triangular thread profile along a right-hand helix. minor radius r0, thread
   depth dr, pitch p, height H; caps at both ends. Lower flanks lean
   atan((p/2)/dr) off the plate - 39.8 deg here, an overhang. */
function threadedShank(r0, dr, p, H, nTheta, nZ) {
  const R = (th, z) => {
    let u = ((z - p * th / (2 * Math.PI)) / p) % 1;
    if (u < 0) u += 1;
    return r0 + dr * (1 - Math.abs(2 * u - 1));
  };
  const V = (i, k) => {
    const th = 2 * Math.PI * i / nTheta, z = H * k / nZ, r = R(th, z);
    return [r * Math.cos(th), r * Math.sin(th), z];
  };
  const out = [];
  for (let i = 0; i < nTheta; i++) for (let k = 0; k < nZ; k++) {
    const a = V(i, k), b = V(i + 1, k), c = V(i + 1, k + 1), d = V(i, k + 1);
    out.push(...a, ...b, ...c, ...a, ...c, ...d);
  }
  for (let i = 0; i < nTheta; i++) {
    out.push(0, 0, 0, ...V(i + 1, 0), ...V(i, 0));
    out.push(0, 0, H, ...V(i, nZ), ...V(i + 1, nZ));
  }
  return new Float32Array(out);
}
const SHANK = { r0: 5, dr: 1.2, p: 2, H: 20 };
const SHANK_SOUP = threadedShank(SHANK.r0, SHANK.dr, SHANK.p, SHANK.H, 96, 160);

/* A 30 x 30 x 10 block with a 10 x 10 vertical hole through it, as four
   bars. `z0` lifts it off the plate. */
const holedBox = z0 => soupOf(box([0, 0, z0], [10, 30, z0 + 10]), box([20, 0, z0], [30, 30, z0 + 10]),
                              box([10, 0, z0], [20, 10, z0 + 10]), box([10, 20, z0], [20, 30, z0 + 10]));

/* A hollow block lifted 5 mm: a 20 x 20 x 10 shell round a 10 x 10 x 4
   cavity (inner shell wound inwards). The plate is z = 0. */
function invert(s) {
  const o = s.slice();
  for (let t = 0; t < o.length; t += 9) for (let k = 0; k < 3; k++) {
    const a = o[t + 3 + k]; o[t + 3 + k] = o[t + 6 + k]; o[t + 6 + k] = a;
  }
  return o;
}
const CAVITY = soupOf(box([0, 0, 5], [20, 20, 15]), invert(box([5, 5, 8], [15, 15, 12])));

/* A knife edge: a triangular bar, apex down at z = 10, faces 60 deg off the
   plate (printable on their own), floating. And an inverted square pyramid
   whose tip hangs at z = 8. */
function knife() {
  const h = 4, w = h / Math.tan(60 * Math.PI / 180), y0 = 5.3;
  const A = [0, y0, 10], B = [30, y0, 10];
  const L = [0, y0 - w, 10 + h], Rr = [0, y0 + w, 10 + h], L2 = [30, y0 - w, 10 + h], R2 = [30, y0 + w, 10 + h];
  const t = [[A, L, L2], [A, L2, B], [A, B, R2], [A, R2, Rr], [L, Rr, R2], [L, R2, L2], [A, Rr, L], [B, L2, R2]];
  const out = [];
  for (const tri of t) out.push(...tri[0], ...tri[2], ...tri[1]);    /* wound outwards */
  return new Float32Array(out);
}
function pyramidTip() {
  const T = [10.3, 10.3, 8], h = 6, w = h / Math.tan(60 * Math.PI / 180);
  const c = [[T[0] - w, T[1] - w, 14], [T[0] + w, T[1] - w, 14], [T[0] + w, T[1] + w, 14], [T[0] - w, T[1] + w, 14]];
  const out = [];
  for (let k = 0; k < 4; k++) out.push(...T, ...c[(k + 1) % 4], ...c[k]);
  out.push(...c[0], ...c[1], ...c[2], ...c[0], ...c[2], ...c[3]);
  return new Float32Array(out);
}

/* ======================================================================== */
console.log('\n=== 1. TILTED BOX: every cell under the 30 deg face, at any tessellation ===');

const tb = {};
for (const n of [1, 10, 32]) {
  const soup = tiltedBox(n);
  const t0 = Date.now();
  tb[n] = { d: SB.detect(soup, { plateZ: 0 }), tris: soup.length / 9, ms: Date.now() - t0 };
}
{
  const d = tb[1].d, g = d.grid;
  check('tilted box: detected', d.ok, d.reason);
  const xMax = 40 * Math.cos(TILT), xMin = SB.MIN_DROP_MM / Math.tan(TILT);
  /* Under the face = the centre's plan point is over the underside AND that
     point of the face is more than minDropMm off the plate (below it the face
     is resting, by the same rule as detectOverhangs). */
  let under = 0, covered = 0, stray = 0;
  for (let j = 0; j < g.ny; j++) for (let i = 0; i < g.nx; i++) {
    const [x, y] = centre(g, i, j);
    const isUnder = x > xMin && x < xMax && y > 0 && y < 30;
    const has = d.beacons.some(b => b.cell[0] === i && b.cell[1] === j && b.need.kind === 'face');
    if (isUnder) { under++; if (has) covered++; } else if (has) stray++;
  }
  check('tilted box: every cell under the face has a face beacon', under > 0 && covered === under,
    `${covered} of ${under} cells`);
  check('tilted box: no face beacon in a cell that is not under it', stray === 0, `${stray} stray`);
  /* The face's plan area, 40 cos 30 x 30 = 1039.2 mm^2. A 34.64 mm run at a
     3 mm pitch is 11.5 cells, so a grid holds 11 or 12 columns of it
     depending on where the footprint puts the first centre: 110 or 120, -4.8%
     or +3.9%. Both are inside 5%. */
  const area = xMax * 30, expect = area / (g.pitch * g.pitch);
  check('tilted box: count within 5% of the face\'s plan area / pitch^2',
    Math.abs(d.beacons.length - expect) <= 0.05 * expect,
    `${d.beacons.length} beacons vs ${expect.toFixed(1)} (${area.toFixed(1)} mm^2 / ${g.pitch}^2, ` +
    `${(100 * (d.beacons.length / expect - 1)).toFixed(1)}%), ${kinds(d)}`);
  const onFace = d.beacons.every(b => near(b.z, b.x * Math.tan(TILT), 1e-3));
  check('tilted box: every beacon sits ON the underside (z = x tan 30)', onFace);
  const ang = d.beacons.every(b => near(b.need.angle, 30, 1e-3) && b.need.below === 'plate');
  check('tilted box: need.angle is the face tilt, 30 deg, open to the plate', ang);
  check('tilted box: normals are the face normal (sin 30, 0, -cos 30)',
    d.beacons.every(b => near(b.normal[0], Math.sin(TILT), 1e-5) && near(b.normal[2], -Math.cos(TILT), 1e-5)));
}
{
  /* Same cell, same kind, same point. The subdivided faces are float32
     points of a rotated grid, so the plane itself moves by ~1e-6 mm; the
     tolerance is that, not a fudge on the sampling. */
  const same = (A, B) => {
    let worst = 0;
    for (const a of A.beacons) {
      const b = B.beacons.find(q => q.cell[0] === a.cell[0] && q.cell[1] === a.cell[1] && q.need.kind === a.need.kind);
      if (!b) return Infinity;
      worst = Math.max(worst, Math.abs(a.x - b.x), Math.abs(a.y - b.y), Math.abs(a.z - b.z));
    }
    return worst;
  };
  for (const n of [10, 32]) {
    check(`tessellation: ${tb[1].tris} triangles and ${tb[n].tris} triangles (underside ${2 * n * n}) give the same count`,
      tb[n].d.beacons.length === tb[1].d.beacons.length,
      `${tb[1].d.beacons.length} vs ${tb[n].d.beacons.length} (${tb[n].ms} ms)`);
    const w = same(tb[1].d, tb[n].d);
    check(`tessellation: ...and the same beacons, cell for cell (${n}x)`, w < 1e-5, `worst ${w.toExponential(2)} mm`);
  }
}

console.log('\n=== 2. SHELF: a flat underside, fully covered ===');
{
  const d = SB.detect(SHELF, { plateZ: 0 }), g = d.grid;
  let under = 0, covered = 0;
  for (let j = 0; j < g.ny; j++) for (let i = 0; i < g.nx; i++) {
    const [x, y] = centre(g, i, j);
    if (!(x > 10 && x < 22 && y > 0 && y < 10)) continue;
    under++;
    if (d.beacons.some(b => b.cell[0] === i && b.cell[1] === j && b.need.kind === 'face' && near(b.z, 16, 1e-4))) covered++;
  }
  check('shelf: every cell under the arm has a face beacon at z = 16', under > 0 && covered === under,
    `${covered} of ${under} cells, ${d.beacons.length} beacons, ${kinds(d)}`);
  check('shelf: every beacon is on the arm underside, within its footprint',
    d.beacons.every(b => near(b.z, 16, 1e-4) && b.x >= 10 - 1e-6 && b.x <= 22 + 1e-6 && b.y >= -1e-6 && b.y <= 10 + 1e-6));
  check('shelf: one region, aimed under the arm', d.regions.length === 1 &&
    d.regions[0].point[0] > 10 && d.regions[0].point[0] < 22 && near(d.regions[0].point[2], 16, 1e-4),
    d.regions.map(r => `${r.count} @ [${r.point.map(c => c.toFixed(2))}]`).join('; '));
}

console.log('\n=== 3. BRIDGE: gap beacons across a 20 mm span, none across 4 mm ===');
{
  const d = SB.detect(bridge(20), { plateZ: 0 }), g = d.grid;
  let under = 0, covered = 0;
  for (let j = 0; j < g.ny; j++) for (let i = 0; i < g.nx; i++) {
    const [x, y] = centre(g, i, j);
    if (!(x > 5 && x < 25 && y > 0 && y < 10)) continue;
    under++;
    if (d.beacons.some(b => b.cell[0] === i && b.cell[1] === j && b.need.kind === 'gap')) covered++;
  }
  check('20 mm bridge: every cell under the span has a gap beacon', under > 0 && covered === under,
    `${covered} of ${under}, ${kinds(d)}`);
  check('20 mm bridge: each reports the 20 mm span and the 10 mm drop',
    d.beacons.filter(b => b.need.kind === 'gap').every(b => near(b.need.spanMm, 20, 1e-3) && near(b.need.gapBelow, 10, 1e-4)));
  check('20 mm bridge: nothing on the pillars - a slab flush on a pillar is resting',
    d.beacons.every(b => b.x > 5 - 1e-6 && b.x < 25 + 1e-6));
  const short = SB.detect(bridge(4), { plateZ: 0 });
  check('4 mm bridge: inside the 5 mm bridgeable span, no beacon', short.ok && short.beacons.length === 0,
    `${short.beacons.length} beacons, ${short.counts.bridged} bridged crossings`);
  const strict = SB.detect(bridge(4), { plateZ: 0, bridgeMm: 3 });
  check('4 mm bridge with bridgeMm 3: gap beacons again', strict.beacons.length > 0 &&
    strict.beacons.every(b => b.need.kind === 'gap' || b.need.kind === 'edge'), kinds(strict));
}

console.log('\n=== 4. MUSHROOM: beacons under the cap, none inside the stem ===');
for (const [name, soup] of [['mushroom (probe fixture)', MUSHROOM], ['mushroom (cap flush on stem)', MUSHROOM_FLUSH]]) {
  const d = SB.detect(soup, { plateZ: 0 }), g = d.grid;
  let under = 0, covered = 0;
  for (let j = 0; j < g.ny; j++) for (let i = 0; i < g.nx; i++) {
    const [x, y] = centre(g, i, j);
    if (x > 4 && x < 8 && y > 4 && y < 8) continue;
    under++;
    if (d.beacons.some(b => b.cell[0] === i && b.cell[1] === j && near(b.z, 20, 1e-4))) covered++;
  }
  check(`${name}: every cell under the cap ring has a beacon at z = 20`, covered === under,
    `${covered} of ${under}, ${d.beacons.length} beacons, ${kinds(d)}`);
  const inside = d.beacons.filter(b => b.x > 4 + 1e-6 && b.x < 8 - 1e-6 && b.y > 4 + 1e-6 && b.y < 8 - 1e-6);
  check(`${name}: none inside the stem`, inside.length === 0 && d.beacons.every(b => near(b.z, 20, 1e-4)),
    inside.length ? JSON.stringify(inside.map(b => [b.x, b.y, b.z])) : '');
}

console.log('\n=== 5. THREADED SHANK: side beacons round every turn, lateral normals ===');
{
  const t0 = Date.now();
  const d = SB.detect(SHANK_SOUP, { plateZ: 0 });
  const ms = Date.now() - t0;
  const ridge = d.beacons.filter(b => b.need.kind === 'ridge');
  check('shank: detected', d.ok, `${d.reason} (${SHANK_SOUP.length / 9} triangles, ${ms} ms)`);
  const turns = Math.round(SHANK.H / SHANK.p);
  let full = 0, detail = [];
  for (let k = 1; k < turns - 1; k++) {
    /* one full turn of the helix, followed round: phase z - p*theta/2pi in [k p, (k+1) p) */
    const on = ridge.filter(b => {
      let th = Math.atan2(b.y, b.x); if (th < 0) th += 2 * Math.PI;
      const ph = b.z - SHANK.p * th / (2 * Math.PI);
      return ph >= k * SHANK.p && ph < (k + 1) * SHANK.p;
    });
    const quads = new Set(on.map(b => Math.floor(((Math.atan2(b.y, b.x) + 2 * Math.PI) % (2 * Math.PI)) / (Math.PI / 2))));
    if (quads.size === 4) full++;
    detail.push(`${on.length}`);
  }
  check(`shank: every inner turn (${turns - 2}) has ridge beacons in all four quadrants`, full === turns - 2,
    `per turn: ${detail.join(' ')}; ${kinds(d)}`);
  check('shank: every ridge normal is lateral (n.z = 0) and points out of the shank',
    ridge.length > 0 && ridge.every(b => b.normal[2] === 0 &&
      (b.normal[0] * b.x + b.normal[1] * b.y) / Math.hypot(b.x, b.y) > 0.9));
  const radii = ridge.map(b => Math.hypot(b.x, b.y));
  check('shank: ridge beacons sit 0.35 mm off the root wall (r0 + 0.35, +/- facet)',
    radii.every(r => r > SHANK.r0 + 0.2 && r < SHANK.r0 + 0.55),
    `radius ${Math.min(...radii).toFixed(3)} .. ${Math.max(...radii).toFixed(3)}, root at ${SHANK.r0}`);
  check('shank: and each reports the standoff it was placed at',
    ridge.every(b => b.need.side === true && b.need.standoffMm === 0.35));
  check('shank: nothing on the core - no face/gap beacon inside the minor radius',
    d.beacons.every(b => Math.hypot(b.x, b.y) > SHANK.r0 - 0.05));
}

console.log('\n=== 6. THROUGH-HOLE: no beacons on the hole\'s walls ===');
{
  const d = SB.detect(holedBox(0), { plateZ: 0 });
  check('holed box on the plate: no beacon anywhere', d.ok && d.beacons.length === 0, d.reason);
  const f = SB.detect(holedBox(6), { plateZ: 0 });
  const inHole = f.beacons.filter(b => b.x > 10 - 1e-6 && b.x < 20 + 1e-6 && b.y > 10 - 1e-6 && b.y < 20 + 1e-6);
  check('holed box lifted 6 mm: beacons only on its underside, none in or on the hole',
    f.beacons.length > 0 && f.beacons.every(b => near(b.z, 6, 1e-4)) && inHole.length === 0,
    `${f.beacons.length} beacons, ${inHole.length} in the hole, ${kinds(f)}`);
}

console.log('\n=== 7. CAVITY: exposed only - the ceiling inside is not a beacon ===');
{
  const d = SB.detect(CAVITY, { plateZ: 0 }), g = d.grid;
  let under = 0, ceil = 0, cav = 0;
  for (let j = 0; j < g.ny; j++) for (let i = 0; i < g.nx; i++) {
    const [x, y] = centre(g, i, j);
    if (!(x > 5 && x < 15 && y > 5 && y < 15)) continue;
    cav++;
    const here = d.beacons.filter(b => b.cell[0] === i && b.cell[1] === j);
    if (here.some(b => near(b.z, 5, 1e-4) && b.need.kind === 'face')) under++;
    if (here.some(b => near(b.z, 12, 1e-4))) ceil++;
  }
  /* Before exposed-only each of these cells held two beacons, the underside
     at z 5 and the cavity ceiling at z 12 (a 'gap' over material). The
     ceiling's ray runs down into the cavity floor, so it is interior. */
  check('cavity: every cell over the cavity holds its underside beacon, and no ceiling',
    cav > 0 && under === cav && ceil === 0, `${under} of ${cav} undersides, ${ceil} ceilings, ${kinds(d)}`);
  check('cavity: one region (the underside), the ceiling counted out as interior',
    d.regions.length === 1 && near(d.regions[0].point[2], 5, 1e-4) && d.counts.interior > 0,
    d.regions.map(r => `${r.count} @ z ${r.point[2].toFixed(2)}`).join('; ') + `, ${d.counts.interior} interior`);
}

console.log('\n=== 8. EDGE and TIP: downward features with no steep face ===');
{
  const d = SB.detect(knife(), { plateZ: 0 });
  const e = d.beacons.filter(b => b.need.kind === 'edge');
  check('knife edge (faces 60 deg off the plate): edge beacons along it, nothing else',
    e.length >= 10 && e.length === d.beacons.length && e.every(b => near(b.z, 10, 1e-4) && near(b.y, 5.3, 1e-4)),
    `${e.length} edge beacons, ${kinds(d)}`);
  const t = SB.detect(pyramidTip(), { plateZ: 0 });
  check('inverted pyramid: one tip beacon at the tip', t.beacons.length === 1 && t.beacons[0].need.kind === 'tip' &&
    near(t.beacons[0].z, 8, 1e-4), kinds(t));
}

console.log('\n=== 9. PAINT, and refusals ===');
{
  const painted = SB.detect(SHELF, { plateZ: 0, skipList: [{ axisIdx: 2, keepMin: true, d: 16 }] });
  check('painting the arm underside takes its beacons out', painted.ok && painted.beacons.length === 0,
    `${painted.beacons.length} beacons, ${painted.counts.painted} painted crossings`);
  check('a null skip list is refused by name', !SB.detect(SHELF, { skipList: null }).ok);
  check('not a soup is refused', !SB.detect(new Float32Array(5)).ok);
}

console.log('\n=== 10. detectOverhangs, the wrapper ===');
{
  const CANTILEVER = soupOf(box([0, 0, 0], [10, 10, 20]), box([10, 0, 16], [30, 10, 20]));
  const d = SA.detectOverhangs(CANTILEVER, { skipList: [] });
  check('the legacy region is unchanged: 200 mm^2 at [20, 5, 16]',
    d.regions.length === 1 && near(d.regions[0].areaMm2, 200, 1e-3) && near(d.regions[0].point[0], 20, 1e-4));
  check('the beacons ride along: det.beacons, det.grid, det.beaconRegions',
    Array.isArray(d.beacons) && d.beacons.length > 0 && d.grid && d.grid.pitch === 3 &&
    d.beaconRegions.length === 1, d.beaconsReason);
  check('each legacy region carries the beacons that sit on its own triangles',
    d.regions[0].beacons.length === d.beacons.length &&
    d.regions[0].beacons.every(b => d.regions[0].tris.indexOf(b.tri) >= 0), `${d.regions[0].beacons.length}`);
  const off = SA.detectOverhangs(CANTILEVER, { skipList: [], beacons: false });
  check('opts.beacons false skips the grid', off.beacons === null && !off.regions[0].beacons);
  const refused = SA.detectOverhangs(CANTILEVER, {});
  check('the wrapper keeps the "no unpainted default" refusal', !refused.ok && /skipList/.test(refused.reason));
}

console.log('\n=== 11. a real part ===');
{
  const f = 'fixtures/tape_on-edge-single-B101_rounded_v8_FINAL.stl';
  const soup = readSTL(path.join(ROOT, f));
  /* In calibration loops (tools/nso_pace.js), not seconds: the old 2 s on the
     box it was set on. */
  const DETECT_LOOPS_MAX = 7;
  const t = pace.time(() => SB.detect(soup, {})), d = t.value, ms = Math.round(t.ms);
  console.log(pace.finding('the tape\'s detect', t));
  check(`${path.basename(f)}: ${soup.length / 9} triangles in under ${DETECT_LOOPS_MAX} calibration loops`, d.ok && t.loops < DETECT_LOOPS_MAX,
    `${t.loops.toFixed(2)} loops (${ms} ms), ${d.reason}`);
  const legacy = SA.detectOverhangs(soup, { skipList: [], beacons: false });
  const big = legacy.regions[0];
  const inBig = d.beacons.filter(b => b.x >= big.min[0] && b.x <= big.max[0] && b.y >= big.min[1] &&
    b.y <= big.max[1] && b.z >= big.min[2] - 1e-3 && b.z <= big.max[2] + 1e-3);
  const plan = (big.max[0] - big.min[0]) * (big.max[1] - big.min[1]);
  check('tape: beacons cover the on-edge underside detectOverhangs reports as its biggest region',
    inBig.length > 0, `${inBig.length} beacons in its ${plan.toFixed(0)} mm^2 plan box (${big.areaMm2.toFixed(0)} mm^2 of face)`);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log('FAILED:\n  ' + FAILS.join('\n  ')); process.exit(1); }
