#!/usr/bin/env node
// Supports hold what is exposed, the whole face, on a foot (supports-exposed).
//
//   node tools/nso_support_exposed_test.js        exit 0 = every gate held
//
// Loads the shipped files with vm in index.html's order and builds through the
// shipped union kernel (tools/nso_csg_node.js). Every solid it builds goes to
// tools/support-exposed-out/ and through tools/mesh_validate.py.
//
//   1. EXPOSED ONLY. library/box_closed.stl (a base with a sealed cavity and a
//      lid on it), tilted 30 deg: one area, the underside; no beacon on the
//      cavity's ceiling, floor or walls; every beacon has a way out along its
//      own normal (checked here by brute force, sharing nothing with the
//      module's index). Stood flat it has nothing to hold - before this ticket
//      its cavity gave it 276 beacons. fixtures/box_open.stl, the same box
//      with the top off: still one area.
//   2. HOLD THE WHOLE FACE. Every underside beacon has a route to the plate:
//      held == beacons == the area's own count, none unreachable, none left
//      out because its neighbours merged; trunks keep the 4x area cap.
//   3. LEAN <= 30 deg, and the low edge: trunks run to the last beacon of the
//      slope (the last 15 mm of it had none).
//   4. THE FOOT. A one-first-layer pad under every landed trunk,
//      r = max(3 mm, 2.5 x half-width), joined where pads touch; nothing below
//      the plate, on a steered trunk too; clear of the piece.
//   + mesh_validate on every solid: closed, manifold, no piercing pairs.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'tools', 'support-exposed-out');
const { writeSTL, readSTL } = require('./nso_stl_io.js');
const { csgContext } = require('./nso_csg_node.js');
const { minTriDistance } = require('./nso_tri_distance.js');

const ctx = {
  Math, Map, Set, console, Array, Object, Number, String, JSON, isFinite, Promise,
  Float32Array, Float64Array, Int32Array, Uint32Array, Uint8Array, ArrayBuffer
};
vm.createContext(ctx);
for (const f of ['nso_thickness.js', 'nso_seat_surface.js', 'app-sculpt.js', 'app-extend.js',
                 'nso_support_beacons.js', 'nso_support_aim.js', 'nso_path_sweep.js', 'nso_support_tree.js',
                 'nso_support_gridpack.js']) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
}
const SB = ctx.NSO_SupportBeacons, GP = ctx.NSO_SupportGridpack, ST = ctx.NSO_SupportTree;

let pass = 0, fail = 0;
const FAILS = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok    ' + name + (detail ? '   ' + detail : '')); }
  else { fail++; FAILS.push(name); console.log('  FAIL  ' + name + (detail ? '   ' + detail : '')); }
}
const near = (a, b, tol) => Math.abs(a - b) <= tol;

/* ---- fixtures ----------------------------------------------------------- */
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
/* Turned `deg` about Y, then dropped onto z = 0 - the other suites' own. */
function tilted(soup, deg) {
  const t = deg * Math.PI / 180, c = Math.cos(t), s = Math.sin(t), o = [];
  for (let i = 0; i < soup.length; i += 3) o.push(c * soup[i] + s * soup[i + 2], soup[i + 1], -s * soup[i] + c * soup[i + 2]);
  let mz = Infinity;
  for (let i = 2; i < o.length; i += 3) mz = Math.min(mz, o[i]);
  for (let i = 2; i < o.length; i += 3) o[i] -= mz;
  return new Float32Array(o);
}
const load = f => { const r = readSTL(path.join(ROOT, f)); return new Float32Array(r.tris || r); };

const CLOSED = load('library/box_closed.stl');     /* 60 x 40 x 27.3: a base, a 26 x 36 cavity under a lid */
const OPEN = load('fixtures/box_open.stl');        /* 60 x 40 x 25, the same cavity with the top off */
const HOLE = soupOf(box([0, 0, 0], [20, 6, 8]), box([0, 14, 0], [20, 20, 8]), box([0, 6, 0], [6, 14, 8]),
                    box([14, 6, 0], [20, 14, 8]), box([15, 8, 8], [19, 12, 22]), arm(5, 19, 5, 15, 22, 25, 1, [[15, 19, 8, 12]]));
const HIGH = soupOf(box([0, 0, 0], [10, 10, 64]), box([10, 0, 60], [30, 10, 64]));

/* ---- helpers shared with nothing in the module -------------------------- */
function triOf(soup, t) {
  const o = t * 9;
  return [[soup[o], soup[o + 1], soup[o + 2]], [soup[o + 3], soup[o + 4], soup[o + 5]], [soup[o + 6], soup[o + 7], soup[o + 8]]];
}
/* Moller-Trumbore, double sided: t along d, or -1. */
function rayHit(o, d, tri) {
  const [a, b, c] = tri, e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const p = [d[1] * e2[2] - d[2] * e2[1], d[2] * e2[0] - d[0] * e2[2], d[0] * e2[1] - d[1] * e2[0]];
  const det = e1[0] * p[0] + e1[1] * p[1] + e1[2] * p[2];
  if (Math.abs(det) < 1e-14) return -1;
  const tv = [o[0] - a[0], o[1] - a[1], o[2] - a[2]];
  const u = (tv[0] * p[0] + tv[1] * p[1] + tv[2] * p[2]) / det;
  if (u < -1e-9 || u > 1 + 1e-9) return -1;
  const q = [tv[1] * e1[2] - tv[2] * e1[1], tv[2] * e1[0] - tv[0] * e1[2], tv[0] * e1[1] - tv[1] * e1[0]];
  const v = (d[0] * q[0] + d[1] * q[1] + d[2] * q[2]) / det;
  if (v < -1e-9 || u + v > 1 + 1e-9) return -1;
  return (e2[0] * q[0] + e2[1] * q[1] + e2[2] * q[2]) / det;
}
/* Does the ray from a beacon along its own normal run into the piece? */
function blocked(soup, b) {
  const o = [b.x, b.y, b.z], d = b.normal;
  for (let t = 0; t < soup.length / 9; t++) {
    const h = rayHit(o, d, triOf(soup, t));
    if (h > 1e-3) return true;
  }
  return false;
}
/* Every z a vertical line at (x, y) crosses a soup at, sorted. */
function zCrossings(soup, x, y) {
  const out = [];
  for (let t = 0; t < soup.length / 9; t++) {
    const o = t * 9;
    if (x < Math.min(soup[o], soup[o + 3], soup[o + 6]) - 1e-9 || x > Math.max(soup[o], soup[o + 3], soup[o + 6]) + 1e-9 ||
        y < Math.min(soup[o + 1], soup[o + 4], soup[o + 7]) - 1e-9 || y > Math.max(soup[o + 1], soup[o + 4], soup[o + 7]) + 1e-9) continue;
    const h = rayHit([x, y, -10], [0, 0, 1], triOf(soup, t));
    if (h >= 0) out.push(h - 10);
  }
  return out.sort((a, b) => a - b);
}
/* Is there a slab (a floor at z0 and a ceiling at z1, nothing else near the
   plate) of this thickness at (x, y)? */
function slabAt(soup, x, y, z0, z1) {
  const zs = zCrossings(soup, x, y).filter(z => z < z1 + 0.5);
  return zs.some(z => near(z, z0, 1e-4)) && zs.some(z => near(z, z1, 1e-4));
}

const validate = (file, weld) => JSON.parse(execFileSync('python3',
  [path.join(ROOT, 'tools', 'mesh_validate.py'), file, '--json'].concat(weld ? ['--weld', String(weld)] : []),
  { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }));
function shells(soup) {
  const id = new Map(), parent = [];
  const find = i => { while (parent[i] !== i) i = parent[i] = parent[parent[i]]; return i; };
  const vid = k => { if (!id.has(k)) { id.set(k, parent.length); parent.push(parent.length); } return id.get(k); };
  for (let t = 0; t < soup.length; t += 9) {
    const a = vid(soup[t] + ',' + soup[t + 1] + ',' + soup[t + 2]);
    for (const o of [3, 6]) { const b = vid(soup[t + o] + ',' + soup[t + o + 1] + ',' + soup[t + o + 2]); parent[find(a)] = find(b); }
  }
  const roots = new Set();
  for (let i = 0; i < parent.length; i++) roots.add(find(i));
  return roots.size;
}
function validSolid(label, soup, solids, handlesAllowed) {
  const file = path.join(OUT, label + '.stl');
  writeSTL(file, soup);
  let v = validate(file, 1e-4);
  if (v.verdict !== 'PASS') v = validate(file, 1e-6);
  check(`${label}: mesh_validate - closed, manifold, no degenerate or piercing triangles`,
    !v.open_edges && !v.nonmanifold_edges && !v.degenerate_tris && !v.inconsistent_winding_edges && !v.self_intersection.pierce,
    `${v.triangles} tris, open ${v.open_edges}, non-manifold ${v.nonmanifold_edges}, degenerate ${v.degenerate_tris}, piercing ${v.self_intersection.pierce}`);
  if (solids >= 0) check(`${label}: one shell per solid`, shells(soup) === solids, `${shells(soup)} shell(s), ${solids} solid(s)`);
  if (!handlesAllowed) check(`${label}: no handles - Euler ${2 * solids}`, v.euler_characteristic === 2 * solids, `Euler ${v.euler_characteristic}`);
  check(`${label}: positive volume`, v.signed_volume > 0, v.signed_volume.toFixed(2) + ' mm^3');
  return v;
}
const minZ = soup => { let m = Infinity; for (let i = 2; i < soup.length; i += 3) m = Math.min(m, soup[i]); return m; };
/* Every leg of every member within the lean limit (a side point's stub is
   horizontal by design and is left out). */
function worstLean(p) {
  let worst = 0;
  for (const m of p.members) {
    if (m.dead) continue;
    for (let i = 0; i + 1 < m.path.length; i++) {
      if (m.kind === 'side' && i === 0) continue;
      const a = m.path[i], b = m.path[i + 1], h = Math.hypot(b[0] - a[0], b[1] - a[1]), dz = Math.abs(b[2] - a[2]);
      if (h + dz < 1e-9) continue;
      worst = Math.max(worst, Math.atan2(h, dz) * 180 / Math.PI);
    }
  }
  for (const s of p.stubs) {
    const h = Math.hypot(s.to[0] - s.from[0], s.to[1] - s.from[1]), dz = s.to[2] - s.from[2];
    worst = Math.max(worst, Math.atan2(h, dz) * 180 / Math.PI);
  }
  return worst;
}
const landing = (p, tr) => { const m = p.members[tr.root]; return m.path[m.path.length - 1]; };

fs.mkdirSync(OUT, { recursive: true });

(async () => {
  const csg = csgContext();
  const K = { unionSoups: csg.NSO_unionSoups };

  /* ===================================================================== */
  console.log('\n=== 1. EXPOSED ONLY: the closed box, tilted 30 deg ===');
  const closed30 = tilted(CLOSED, 30);
  /* The faces that look into the sealed cavity, found on the untilted box
     (indices survive the tilt): the cavity's own walls and floor, and the
     lid's underside, which is its ceiling. */
  const inside = new Set();
  for (let t = 0; t < CLOSED.length / 9; t++) {
    const tri = triOf(CLOSED, t);
    const inCavity = tri.every(v => v[0] > 1.9 && v[0] < 58.1 && v[1] > 1.9 && v[1] < 38.1 && v[2] > 1.9 && v[2] < 25.01);
    const lidUnder = tri.every(v => near(v[2], 24.9, 1e-4));
    if (inCavity || lidUnder) inside.add(t);
  }
  const d30 = SB.detect(closed30, { plateZ: 0 });
  check('the cavity is 12 faces: 10 walls and floor, 2 for the lid\'s underside', inside.size === 12, `${inside.size} faces`);
  check('one area - the underside', d30.ok && d30.regions.length === 1 && d30.regions[0].count === d30.beacons.length,
    `${d30.regions.length} region(s), ${d30.beacons.length} beacon(s): ${d30.reason}`);
  check('0 interior beacons: none on the cavity\'s ceiling, floor or walls',
    d30.beacons.every(b => !inside.has(b.tri)), `${d30.beacons.filter(b => inside.has(b.tri)).length} on the cavity`);
  check('...and they were found and left out, not missed', d30.counts.interior > 0, `${d30.counts.interior} interior spot(s) counted out`);
  const under = d30.beacons.filter(b => near(b.need.angle, 30, 0.05));
  check('every beacon is on the 30 deg underside: kind face, open to the plate, normal 30 deg off straight down',
    under.length === d30.beacons.length && d30.beacons.every(b => b.need.kind === 'face' && b.need.below === 'plate' &&
      near(-b.normal[2], Math.cos(Math.PI / 6), 1e-4)), `${under.length} of ${d30.beacons.length}`);
  const bad = d30.beacons.filter(b => blocked(closed30, b));
  check('every beacon has a way out: its ray along its own normal meets nothing of the piece (brute force)',
    bad.length === 0, `${bad.length} blocked of ${d30.beacons.length}`);
  const flat = SB.detect(CLOSED, { plateZ: 0 });
  check('stood flat the closed box needs nothing (its cavity ceiling gave it 276 beacons before)',
    flat.ok && flat.beacons.length === 0 && flat.regions.length === 0, flat.reason);

  console.log('\n=== 1b. the open hollow box, tilted 30 deg: still one exposed area ===');
  const open30 = tilted(OPEN, 30);
  const cavityO = new Set();
  for (let t = 0; t < OPEN.length / 9; t++) {
    if (triOf(OPEN, t).every(v => v[0] > 1.9 && v[0] < 58.1 && v[1] > 1.9 && v[1] < 38.1 && v[2] > 1.9 && v[2] < 25.01)) cavityO.add(t);
  }
  const o30 = SB.detect(open30, { plateZ: 0 });
  check('one area, the underside', o30.ok && o30.regions.length === 1 && o30.regions[0].count === o30.beacons.length,
    `${o30.regions.length} region(s), ${o30.beacons.length} beacon(s)`);
  check('nothing on the cavity\'s walls', o30.beacons.every(b => !cavityO.has(b.tri) && near(b.need.angle, 30, 0.05)),
    `${cavityO.size} cavity faces`);
  check('every beacon has a way out', o30.beacons.every(b => !blocked(open30, b)));
  check('the open box and the closed box hold the same underside', o30.beacons.length === d30.beacons.length,
    `${o30.beacons.length} and ${d30.beacons.length}`);
  check('stood flat the open box needs nothing', SB.detect(OPEN, { plateZ: 0 }).beacons.length === 0);

  /* ===================================================================== */
  console.log('\n=== 2. HOLD THE WHOLE FACE ===');
  const p = GP.plan(closed30, { skipList: [] });
  check('the plan is made - no refusal', p.ok, p.reason);
  const area = p.detect.regions[0];
  check('the planner\'s points are the area\'s beacons, one for one', p.beacons.length === area.count && p.beacons.length === d30.beacons.length,
    `${p.beacons.length} points, area ${area.count}`);
  check('held count == the area\'s beacon count: every underside beacon has a route to the plate',
    p.held === area.count && !p.unreachable.length && !p.inside.length && !p.resting.length,
    `${p.held} of ${area.count}; ${p.unreachable.length} unreachable, ${p.inside.length} inside`);
  const seen = new Map();
  p.trunks.forEach(t => t.beacons.forEach(id => seen.set(id, (seen.get(id) || 0) + 1)));
  check('...each in exactly one trunk, all landing on the plate',
    seen.size === area.count && [...seen.values()].every(n => n === 1) && p.trunks.every(t => t.landing === 'plate'),
    `${p.trunks.length} trunks`);
  check('the line says so', new RegExp(`^Holds ${area.count} of ${area.count} support points on ${p.trunks.length} trunks to the plate\\.$`).test(p.reason), p.reason);
  check('merging dropped nothing: the tree merged and still holds all',
    p.merges.length > 0 && p.pickups.length > 0 && p.held === area.count, `${p.merges.length} merges, ${p.pickups.length} pickups`);
  check('trunks keep the 4x area cap, never a fatter slab',
    p.members.every(m => Math.abs(m.side * m.side - p.sideMm * p.sideMm * Math.min(m.count, 4)) < 1e-9) &&
    p.members.every(m => m.side <= 2 * p.sideMm + 1e-9), `widest ${Math.max(...p.members.map(m => m.side)).toFixed(2)} mm of a ${p.sideMm} mm strut`);
  const ps = GP.plan(closed30, { skipList: [], style: 'strut' });
  check('strut style holds the whole face too', ps.ok && ps.held === area.count && ps.trunks.length === area.count, ps.reason);

  /* ===================================================================== */
  console.log('\n=== 3. LEAN <= 30 deg, and the low edge ===');
  check('the lean limit is 30 deg', ST.BRANCH_TILT_DEG === 30 && p.branchTiltDeg === 30, `${p.branchTiltDeg}`);
  check('every leg within 30 deg', worstLean(p) <= 30 + 1e-6, worstLean(p).toFixed(3) + ' deg');
  check('...and a face tilted exactly 30 deg is a face a vertical post holds (no side stubs)',
    p.members.every(m => m.kind !== 'side'), `${p.members.filter(m => m.kind === 'side').length} side members`);
  {
    /* The slope falls towards +x; its low edge is on the plate. The last 15 mm
       of the slope is 15 cos 30 = 13 mm of x. */
    const xLow = Math.max(...p.beacons.map(b => b.p[0]));
    const xs = [...new Set(p.trunks.map(t => landing(p, t)[0].toFixed(1)))].map(Number).filter(x => x >= xLow - 15 * Math.cos(Math.PI / 6)).sort((a, b) => b - a);
    let worstGap = 0;
    for (let i = 1; i < xs.length; i++) worstGap = Math.max(worstGap, xs[i - 1] - xs[i]);
    check('trunks stand on the last 15 mm of the slope, to the last beacon',
      xs.length >= 4 && xLow - xs[0] <= 3 && worstGap <= 3.5,
      `${xs.length} rows of trunks, the lowest ${(xLow - xs[0]).toFixed(1)} mm from the last beacon, widest gap ${worstGap.toFixed(1)} mm`);
  }

  /* ===================================================================== */
  console.log('\n=== 4. THE FOOT ===');
  const built = await GP.solid(p, K);
  check('the solids build', built.ok, built.reason);
  const bare = await GP.solid(p, Object.assign({ footPads: false }, K));
  if (built.ok && bare.ok) {
    check('nothing below the plate', minZ(built.soup) >= -1e-6, `lowest z ${minZ(built.soup).toExponential(2)}`);
    const THICK = 0.2;
    let padless = 0, shortRadius = 0;
    for (const tr of p.trunks) {
      const [x, y] = landing(p, tr), side = p.members[tr.root].side;
      const r = Math.max(3, 2.5 * side / 2);
      /* the pad is a slab one first layer thick: out to r everywhere that
         nothing of the piece is within a gap of it. Probe 1 mm in from r. */
      let hit = 0;
      for (let k = 0; k < 8; k++) {
        const a = Math.PI * k / 4;
        if (slabAt(built.soup, x + (r - 1) * Math.cos(a), y + (r - 1) * Math.sin(a), 0, THICK)) hit++;
      }
      /* just outside the column's own corners, on any of eight sides */
      const rc = side / Math.SQRT2 + 0.3;
      let any = false;
      for (let k = 0; k < 8 && !any; k++) any = slabAt(built.soup, x + rc * Math.cos(Math.PI * k / 4), y + rc * Math.sin(Math.PI * k / 4), 0, THICK);
      if (!any) padless++;
      if (hit < 2) shortRadius++;
    }
    check('a pad under every landed trunk: a 0.2 mm slab at the plate', padless === 0, `${padless} of ${p.trunks.length} without`);
    check('...reaching r - 1 mm out on at least two of eight sides (the piece and neighbours may take the rest)',
      shortRadius === 0, `${shortRadius} short`);
    check('pads are joined where they touch: fewer solids than trunks', built.solids.length < p.trunks.length,
      `${p.trunks.length} trunks in ${built.solids.length} solid(s); bare trunks make ${bare.solids.length}`);
    check('without feet the same plan is one solid per trunk and also stops at the plate',
      bare.solids.length === p.trunks.length && minZ(bare.soup) >= -1e-6, `${bare.solids.length}`);
    const v = validSolid('closed30', built.soup, built.solids.length, true);
    const handles = (2 * built.solids.length - v.euler_characteristic) / 2;
    const vb = validSolid('closed30_bare', bare.soup, bare.solids.length, false);
    check('the only handles are rings of pads round a gap - the trunks alone have none', vb.euler_characteristic === 2 * bare.solids.length && handles >= 0,
      `${handles} ring(s) of pads in the first layer`);
    /* The feet keep clear of the piece by the support gap. */
    const slab = [];
    for (let t = 0; t < built.soup.length; t += 9) {
      if (Math.max(built.soup[t + 2], built.soup[t + 5], built.soup[t + 8]) <= THICK + 1e-6) slab.push(...built.soup.slice(t, t + 9));
    }
    const near0 = [];
    for (let t = 0; t < closed30.length; t += 9) {
      if (Math.min(closed30[t + 2], closed30[t + 5], closed30[t + 8]) < 1) near0.push(...closed30.slice(t, t + 9));
    }
    const md = minTriDistance(new Float32Array(slab), new Float32Array(near0));
    check('the feet keep the support gap off the piece (0.18 mm and a hair)', md.mm >= 0.18 - 1e-3, `closest ${md.mm.toFixed(3)} mm over ${md.pairs} pairs`);
  }

  console.log('\n--- the pad\'s radius law: max(3 mm, 2.5 x half-width) ---');
  /* A single strut under a 4 x 4 arm: one trunk, so nothing else's pad can be mistaken for its own. */
  const LONE = soupOf(box([0, 0, 0], [10, 10, 44]), box([10, 3, 40], [14, 7, 44]));
  for (const [label, fix, sideMm, pickWidest] of [['1.2 mm strut', LONE, 1.2, false], ['3 mm strut', LONE, 3, false],
                                                  ['merged 3 mm struts (6 mm trunk)', HIGH, 3, true]]) {
    const q = GP.plan(fix, { skipList: [], sideMm });
    const s = await GP.solid(q, K);
    if (!q.ok || !s.ok) { check(`${label}: plans and builds`, false, q.reason || s.reason); continue; }
    let tr = q.trunks[0];
    for (const t of q.trunks) if (q.members[t.root].side > q.members[tr.root].side) tr = t;
    const root = q.members[tr.root], [x, y] = landing(q, tr);
    const r = Math.max(3, 2.5 * root.side / 2);
    check(`${label}: the trunk is ${root.side.toFixed(2)} mm square, so the pad is ${r.toFixed(2)} mm`,
      pickWidest ? root.side >= 5.99 : q.trunks.length === 1, `${q.trunks.length} trunk(s)`);
    /* some side where nothing else is near: the slab runs out to r and stops */
    let ok = false, at = 0;
    for (let k = 0; k < 16 && !ok; k++) {
      const a = 2 * Math.PI * k / 16, cs = Math.cos(a), sn = Math.sin(a);
      if (slabAt(s.soup, x + (r - 0.1) * cs, y + (r - 0.1) * sn, 0, 0.2) && !slabAt(s.soup, x + (r + 0.3) * cs, y + (r + 0.3) * sn, 0, 0.2)) { ok = true; at = k * 22.5; }
    }
    check(`${label}: a slab out to ${(r - 0.1).toFixed(2)} mm and gone by ${(r + 0.3).toFixed(2)} mm on a free side`, ok,
      `trunk at [${x.toFixed(2)}, ${y.toFixed(2)}], free side ${at} deg`);
    check(`${label}: nothing below the plate`, minZ(s.soup) >= -1e-6);
    if (label === '1.2 mm strut') validSolid('lone', s.soup, s.solids.length, true);
  }

  console.log('\n--- a steered trunk lands upright, on its foot ---');
  {
    const q = GP.plan(HOLE, { skipList: [], regionId: 0 });
    check('the box with a through-hole plans, with points steered into the hole', q.ok && q.steered.length > 0 && q.held === q.beacons.length,
      `${q.steered && q.steered.length} steered; ${q.reason}`);
    const lastLegs = q.members.filter(m => !m.dead && m.end === 'plate').map(m => {
      const a = m.path[m.path.length - 2], b = m.path[m.path.length - 1];
      return Math.atan2(Math.hypot(b[0] - a[0], b[1] - a[1]), a[2] - b[2]) * 180 / Math.PI;
    });
    check('every member lands on a vertical last run', lastLegs.every(a => a < 1e-6), `worst ${Math.max(...lastLegs).toFixed(3)} deg`);
    const s = await GP.solid(q, K);
    check('the solids build, nothing below the plate', s.ok && minZ(s.soup) >= -1e-6, s.ok ? `lowest z ${minZ(s.soup).toExponential(2)}` : s.reason);
    if (s.ok) validSolid('hole', s.soup, s.solids.length, true);
  }

  console.log('\n--- a leaning last leg is stood upright ---');
  {
    /* A member that would reach the plate leaning 22 deg (no fixture of the
       planner's makes one: a steered leg ends on a lattice level above the
       plate), handed straight to the sweep. */
    const m = { id: 0, kind: 'beacon', end: 'plate', side: 2.4, count: 4, path: [[0, 0, 10], [4, 0, 0]] };
    const feet = GP._memberSolid(m, 0.2, { pathSweep: ctx.NSO_PathSweep });
    const bareSw = GP._memberSolid(m, 0, { pathSweep: ctx.NSO_PathSweep });
    check('without a foot the leaning cap dips under the plate (the case this guards)', bareSw.ok && minZ(bareSw.soups[0]) < -0.5,
      `lowest z ${minZ(bareSw.soups[0]).toFixed(3)}`);
    const last = feet.points[feet.points.length - 1], prev = feet.points[feet.points.length - 2];
    check('with one it stops 1 mm short and drops straight: nothing below the plate',
      feet.ok && minZ(feet.soups[0]) >= -1e-9 && near(last[0], prev[0], 1e-9) && near(prev[2] - last[2], 1 - 0.1, 1e-9),
      `lowest z ${minZ(feet.soups[0]).toExponential(2)}, last run ${(prev[2] - last[2]).toFixed(2)} mm above the pad's mid-layer`);
  }

  console.log('\n--- hollow, on its foot ---');
  {
    const TAB = soupOf(box([0, 0, 0], [10, 10, 16]), box([10, 1, 12], [18, 9, 16]));
    const q = ST.planTree(TAB, { skipList: [] });
    const s = await GP.solid(q, Object.assign({ hollow: true, subtractSoups: csg.NSO_subtractSoups }, K));
    check('a hollow support builds on its foot, bored above it', s.ok && s.hollow && s.hollow.cut > 0 && minZ(s.soup) >= -1e-6,
      s.ok ? `${s.hollow && s.hollow.cut} bore(s) cut` : s.reason);
    if (s.ok) {
      const v = validSolid('tab_hollow', s.soup, -1, true);
      check('tab_hollow: the bores are sealed inside - more shells than solids', shells(s.soup) > s.solids.length,
        `${shells(s.soup)} shells, ${s.solids.length} solid(s)`);
      void v;
    }
  }

  console.log('\n' + (fail ? `FAILED  ${fail} of ${pass + fail}` : `PASSED  all ${pass}`));
  if (fail) { console.log('  ' + FAILS.join('\n  ')); process.exit(1); }
})().catch(err => { console.error(err); process.exit(1); });
