/* Carve by drag: press, drag, release = one continuous groove, the blade swept
   along the stroke. Proven in Node and by a real mouse drag in the real app.
     node tools/nso_carve_drag_check.js        exit 0 = every gate held

   Part 1 - nso_carve.js alone, no browser
     a. the groove section is the blade's own silhouette down its sweep axis,
        and the swept body of a straight stroke is one closed solid whose
        volume is section area x length, for every blade.
     b. a stroke that crosses onto another face is refused in words; so is a
        stroke too short to be one (the app punches it instead).
     c. the wall gate refuses a groove that would leave under two nozzle
        widths (0.8 mm at 0.4) - under the floor AND through a side wall - and
        passes one that leaves more.
     d. a drawn U, S or long arc is planned as drawn - on a plane and on a
        sphere, with every blade, hand-shake and a pixel grid included - and
        cut through the real kernel into a valid solid whose groove is where it
        was drawn (floor depth, and the width at the surface, within 0.15 mm).
        A U tighter than the blade is wide is still a valid cut. (These were
        the ones that came out V-shaped, Z-shaped, or refused.)
   Part 2 - the shipped tool, a real pointer drag in real Chromium
     d. on fixtures/box_hull_80x40x20-2.stl, a 20 mm drag with each blade
        (ball-nose, flat shave, V-groove) cuts ONE groove: the section taken
        across it every 0.5 mm along its full length is the blade's section
        within 0.05 mm, both ways (every point of the cut on the blade's
        outline, every vertex of the blade's outline on the cut); the piece
        gates clean on tools/mesh_validate.py; and ONE Undo puts it back
        vertex for vertex, saying "Carve".
     e. a click that does not move still punches, exactly as before.
     f. a groove into a 2 mm floor deeper than 2 - 0.8 mm is refused in words
        and the piece is untouched; one that leaves 0.8 mm is cut.
   A screenshot of the three grooves is written to tools/carve-out/carve-drag.png
   (git-ignored). */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');
const { withApp, loadSTL, selectModel, ROOT } = require('./nso_app_harness');
const NSO_Carve = require(path.join(ROOT, 'nso_carve.js'));
const NSO_PathSweep = require(path.join(ROOT, 'nso_path_sweep.js'));
const NSO_Thickness = require(path.join(ROOT, 'nso_thickness.js'));
const { csgContext } = require(path.join(ROOT, 'tools', 'nso_csg_node.js'));

let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail !== undefined ? ' - ' + detail : ''));
  if (!cond) fails++;
  return !!cond;
};
const near = (a, b, tol) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tol;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nso-carve-drag-'));
const SECTION_TOL = 0.05;

function writeBinarySTL(file, soup) {
  const n = soup.length / 9;
  const buf = Buffer.alloc(84 + n * 50);
  buf.writeUInt32LE(n, 80);
  for (let i = 0; i < n; i++) {
    const o = 84 + i * 50, s = i * 9;
    for (let k = 0; k < 9; k++) buf.writeFloatLE(soup[s + k], o + 12 + k * 4);
  }
  fs.writeFileSync(file, buf);
}
function gate(soup, label) {
  const file = path.join(tmp, label + '.stl');
  writeBinarySTL(file, soup);
  let out, code = 0;
  try { out = execFileSync('python3', [path.join(ROOT, 'tools', 'mesh_validate.py'), file, '--gate', '--json'], { encoding: 'utf8' }); }
  catch (e) { out = e.stdout || ''; code = e.status == null ? 1 : e.status; }
  let j = null;
  try { j = JSON.parse(out); } catch (e) { /* leave null */ }
  return { code, j };
}
/* the canonical verdict plus the explicit topology numbers - nso_carve_test.js's `clean` */
const clean = g => !!(g.j && g.code === 0 && g.j.verdict === 'PASS' &&
  g.j.open_edges === 0 && g.j.nonmanifold_edges === 0 && g.j.odd_edges === 0 &&
  g.j.inconsistent_winding_edges === 0 && g.j.degenerate_tris === 0 &&
  g.j.self_intersection && g.j.self_intersection.pierce === 0 && g.j.euler_characteristic === 2);
const gsum = g => g.j ? ('tris ' + g.j.triangles + ', open ' + g.j.open_edges + ', nm ' + g.j.nonmanifold_edges +
  ', odd ' + g.j.odd_edges + ', wind ' + g.j.inconsistent_winding_edges + ', deg ' + g.j.degenerate_tris +
  ', pierce ' + (g.j.self_intersection ? g.j.self_intersection.pierce : '?') +
  ', euler ' + g.j.euler_characteristic + ', ' + g.j.verdict) : 'checker gave no JSON';

function boxSoup(x0, y0, z0, x1, y1, z1) {
  const v = [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
             [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]];
  const q = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]];
  const s = [];
  for (const f of q) for (const t of [[0, 1, 2], [0, 2, 3]]) for (const k of t) s.push(...v[f[k]]);
  return Float32Array.from(s);
}
const line = (a, b, n, normal) => Array.from({ length: n + 1 }, (_, i) => ({
  point: [a[0] + (b[0] - a[0]) * i / n, a[1] + (b[1] - a[1]) * i / n, a[2] + (b[2] - a[2]) * i / n],
  normal: normal
}));

/* ---- 2D geometry for the section comparison ---- */
function segDist(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy;
  let t = L2 > 0 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}
function distToPolyline(p, pl, closed) {
  let d = Infinity;
  const n = pl.length, m = closed ? n : n - 1;
  for (let i = 0; i < m; i++) d = Math.min(d, segDist(p, pl[i], pl[(i + 1) % n]));
  return d;
}
/* The blade's section, clipped to what lies in the material: the part of the
   outline below the surface (y < depth), with the two points where it crosses
   the surface. An open polyline, lip to lip. */
function expectedGroove(profile, depth) {
  const n = profile.length, out = [];
  let start = -1;
  for (let i = 0; i < n; i++) if (profile[i][1] < depth && profile[(i + n - 1) % n][1] >= depth) start = i;
  if (start < 0) return null;
  const prev = profile[(start + n - 1) % n], first = profile[start];
  const lerp = (a, b) => { const t = (depth - a[1]) / (b[1] - a[1]); return [a[0] + t * (b[0] - a[0]), depth]; };
  out.push(lerp(prev, first));
  for (let k = 0; k < n; k++) {
    const p = profile[(start + k) % n], q = profile[(start + k + 1) % n];
    out.push(p);
    if (q[1] >= depth) { out.push(lerp(p, q)); break; }
  }
  return out;
}
const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm3 = a => { const L = Math.hypot(a[0], a[1], a[2]); return [a[0] / L, a[1] / L, a[2] / L]; };

/* Cut the result across the groove at `along` mm from the press and compare
   it with the blade's section. Returns the two one-way distances in mm. */
function sectionAt(soup, start, u, Y, depth, expected, hw, along) {
  const X = cross3(Y, u);
  const tipRef = [start[0] - Y[0] * depth, start[1] - Y[1] * depth, start[2] - Y[2] * depth];
  const at = [start[0] + u[0] * along, start[1] + u[1] * along, start[2] + u[2] * along];
  const loops = NSO_PathSweep.sectionLoops(soup, at, u);
  if (!loops || !loops.length) return { ok: false, why: 'no section' };
  /* the outer loop: the one with the largest extent */
  const flat = loops.map(l => l.map(p => { const d = sub3(p, tipRef); return [dot3(d, X), dot3(d, Y)]; }));
  flat.sort((a, b) => b.length - a.length);
  const loop = flat[0];
  /* the groove part of the cut: inside the material, within reach of the blade */
  const groove = loop.filter(p => p[1] < depth - 1e-3 && p[1] > -0.5 && Math.abs(p[0]) < hw + 0.5);
  if (!groove.length) return { ok: false, why: 'the section has no groove in it' };
  let cutToBlade = 0, bladeToCut = 0;
  for (const p of groove) cutToBlade = Math.max(cutToBlade, distToPolyline(p, expected, false));
  for (const q of expected) bladeToCut = Math.max(bladeToCut, distToPolyline(q, loop, true));
  return { ok: true, cutToBlade, bladeToCut, points: groove.length };
}

/* ============================================================
   PART 1
   ============================================================ */
function part1() {
  console.log('\n=== Part 1: nso_carve.js, no browser ===');

  console.log('\n--- 1a. the section is the blade\'s, and a straight sweep is section x length ---');
  const blades = [
    ['ball', { radius: 2, height: 4 }],
    ['flat', { width: 4, length: 10, height: 4 }],
    ['vee', { angle: 90, length: 10, height: 4 }]
  ];
  for (const [name, p] of blades) {
    const sec = NSO_Carve.grooveSection(name, p);
    check(name + ': section builds', sec.ok, sec.reason);
    if (!sec.ok) continue;
    /* the section is the z = 0 slice of the blade: every blade vertex at z = 0
       lies on the section's outline */
    const b = NSO_Carve.buildBlade(name, p);
    let worst = 0;
    for (let i = 0; i < b.soup.length; i += 3) {
      if (Math.abs(b.soup[i + 2]) > 1e-6) continue;
      worst = Math.max(worst, distToPolyline([b.soup[i], b.soup[i + 1]], sec.profile, true));
    }
    check('  ... and the blade\'s own z = 0 vertices lie on it', worst < 1e-6, 'worst ' + worst.toExponential(2) + ' mm');
    const pl = NSO_Carve.planStroke(null, line([0, 20, 5], [20, 20, 5], 40, [0, 1, 0]), name, p, { depth: 1.5 });
    check('  ... a 20 mm straight stroke plans as one segment', pl.ok && pl.segments === 1 && near(pl.length, 20, 1e-9),
      pl.ok ? pl.segments + ' segment, ' + pl.length + ' mm' : pl.reason);
    if (!pl.ok) continue;
    const g = gate(pl.sweeps[0].tris, 'sweep_' + name);
    check('  ... whose swept body is one closed solid', clean(g), gsum(g));
    /* the groove reaches GROOVE_ABOVE_MM (1 mm) above the surface and no further: the shank above that
       cuts nothing, and is wider than a bend can fit */
    const top = Math.max(...pl.cutProfile.map(q => q[1]));
    check('  ... whose section is the blade\'s, cut off 1 mm above the surface', near(top, 1.5 + 1, 1e-9) &&
      pl.cutProfile.every(q => sec.profile.some(r => near(r[0], q[0], 1e-9) && near(r[1], q[1], 1e-9)) || near(q[1], top, 1e-9)),
      'top at ' + top + ' mm');
    const want = NSO_PathSweep.polyArea(pl.cutProfile) * 20;
    check('  ... of volume section area x length', g.j && near(g.j.signed_volume, want, 1e-3 * want),
      (g.j ? g.j.signed_volume.toFixed(4) : '?') + ' vs ' + want.toFixed(4) + ' mm^3');
    for (let e = 0; e < 2; e++) {
      const ge = gate(pl.ends[e].soup, 'end_' + name + e);
      check('  ... and the ' + (e ? 'release' : 'press') + ' blade is a closed solid', clean(ge), gsum(ge));
    }
  }

  console.log('\n--- 1b. refusals in words ---');
  const over = line([0, 20, 5], [10, 20, 5], 20, [0, 1, 0]).concat(line([10, 20, 5], [10, 10, 5], 20, [1, 0, 0]).slice(1));
  let r = NSO_Carve.planStroke(null, over, 'ball', { radius: 2, height: 4 }, { depth: 1 });
  check('a stroke that turns over an edge onto another face is refused', !r.ok && /crosses onto another face/.test(r.reason), r.reason);
  r = NSO_Carve.planStroke(null, line([0, 20, 5], [0.05, 20, 5], 2, [0, 1, 0]), 'ball', { radius: 2, height: 4 }, { depth: 1 });
  check('a 0.05 mm stroke is a click, not a groove', !r.ok && r.short === true, r.reason);
  r = NSO_Carve.planStroke(null, line([0, 20, 5], [20, 20, 5], 4, [0, 1, 0]), 'ball', { radius: 2, height: 3 }, { depth: 3.5 });
  check('a depth past the shank is refused', !r.ok && /taller than/.test(r.reason), r.reason);

  console.log('\n--- 1c. the wall gate: two nozzle widths, floor and sides ---');
  /* a 2 mm slab: the floor under a groove on its top */
  const slab = boxSoup(0, 0, 0, 40, 2, 20);
  const P = NSO_Thickness.prepare(slab, {});
  const stroke = line([10, 2, 10], [30, 2, 10], 20, [0, 1, 0]);
  const deep = NSO_Carve.planStroke(slab, stroke, 'ball', { radius: 1, height: 4 }, { depth: 1.5 });
  let w = NSO_Carve.strokeWallGate(P, deep, { nozzle: 0.4 });
  check('1.5 mm into a 2 mm floor (leaves 0.5) is refused', !w.ok, w.reason);
  const words = NSO_Carve.strokeRefusalText(w, 0.4);
  check('  ... in words that name the floor as two nozzle widths and the way out',
    /two 0\.4 mm nozzle widths/.test(words) && /Thicken first/.test(words) && /piece unchanged/.test(words), words);
  check('  ... and that a 0.42 one-line floor would have let it through (0.5 > 0.42)',
    w.gate && w.gate.residual_mm > NSO_Thickness.floorFor(0.4), w.gate ? 'leaves ' + w.gate.residual_mm : '-');
  const ok12 = NSO_Carve.planStroke(slab, stroke, 'ball', { radius: 1, height: 4 }, { depth: 1.15 });
  w = NSO_Carve.strokeWallGate(P, ok12, { nozzle: 0.4 });
  check('1.15 mm into the same floor (leaves 0.85) is allowed', w.ok, w.reason);
  /* a side wall: a flat slab run along the top of a block, 0.5 mm in from its side */
  const block = boxSoup(0, 0, 0, 40, 20, 20);
  const PB = NSO_Thickness.prepare(block, {});
  const side = NSO_Carve.planStroke(block, line([10, 20, 2.5], [30, 20, 2.5], 20, [0, 1, 0]), 'flat',
    { width: 4, length: 4, height: 4 }, { depth: 1 });
  w = NSO_Carve.strokeWallGate(PB, side, { nozzle: 0.4 });
  check('a slab whose side comes 0.5 mm from the block\'s side face is refused, naming the 0.5 mm',
    !w.ok && /side would leave 0\.5 mm of wall/.test(w.reason), w.reason);
  const sideOk = NSO_Carve.planStroke(block, line([10, 20, 3], [30, 20, 3], 20, [0, 1, 0]), 'flat',
    { width: 4, length: 4, height: 4 }, { depth: 1 });
  w = NSO_Carve.strokeWallGate(PB, sideOk, { nozzle: 0.4 });
  check('  ... and one 1.0 mm in is allowed', w.ok, w.reason);
}


/* ============================================================
   PART 1d - curves, through the real kernel
   ============================================================ */
const mul3 = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const add3 = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
function sphereSoup(R, nu, nv) {
  const P = (i, j) => { const th = Math.PI * i / nv, ph = 2 * Math.PI * (j % nu) / nu; return [R * Math.sin(th) * Math.cos(ph), R * Math.cos(th), R * Math.sin(th) * Math.sin(ph)]; };
  const s = [];
  for (let i = 0; i < nv; i++) for (let j = 0; j < nu; j++) {
    const a = P(i, j), b = P(i + 1, j), c = P(i + 1, j + 1), d = P(i, j + 1);
    if (i > 0) s.push(...a, ...d, ...b);
    if (i < nv - 1) s.push(...b, ...d, ...c);
  }
  return Float32Array.from(s);
}
/* two surfaces to draw on: a plane (the top of a block, y = 20) and a sphere of radius R about the origin.
   map(u, v) -> the point on the surface that the drawing's (u, v) lands on, and its outward normal */
const PLANE = { name: 'plane', hull: boxSoup(-70, 0, -70, 70, 20, 70), map: (u, v) => ({ p: [u, 20, v], n: [0, 1, 0] }) };
const sphereOf = R => ({
  name: 'sphere R' + R, hull: sphereSoup(R, 160, 80),
  map: (u, v) => { const th = Math.hypot(u, v) / R, ph = Math.atan2(v, u);
    const n = [Math.sin(th) * Math.cos(ph), Math.cos(th), Math.sin(th) * Math.sin(ph)]; return { p: mul3(n, R), n }; },
  offset: (p, n, lat, x) => { const R_ = Math.hypot(p[0], p[1], p[2]), c = Math.cos(x / R_), s_ = Math.sin(x / R_);
    const q = add3(mul3(n, R_ * c), mul3(lat, R_ * s_)); return { q, nq: norm3(q) }; }
});
/* drawings, as (u, v) of t in [0, 1] */
const DRAW = {
  U: r => t => { const L1 = 15, A = Math.PI * r, L = 2 * L1 + A, s = t * L;
    if (s < L1) return [-r, -s]; if (s < L1 + A) { const a = Math.PI + (s - L1) / r; return [r * Math.cos(a), -L1 + r * Math.sin(a)]; }
    return [r, -L1 + (s - L1 - A)]; },
  S: a => t => [a * Math.sin(t * 2 * Math.PI), 40 * (t - 0.5)],
  arc: R => t => { const a = t * 1.5 * Math.PI; return [R * Math.cos(a), R * Math.sin(a)]; }
};
let seedNoise = 5;
const noise = () => (seedNoise = (seedNoise * 16807) % 2147483647) / 2147483647 - 0.5;
/* the drawing as the pointer reports it: n samples, a pixel grid of `grid` mm, `shake` mm of hand */
function drawn(surf, shape, n, shake, grid) {
  const out = [], ideal = [];
  for (let i = 0; i <= n; i++) {
    const [u, v] = shape(i / n);
    ideal.push(surf.map(u, v));
    const uu = u + (shake ? noise() * shake : 0), vv = v + (shake ? noise() * shake : 0);
    const m = surf.map(grid ? Math.round(uu / grid) * grid : uu, grid ? Math.round(vv / grid) * grid : vv);
    out.push({ point: m.p, normal: m.n });
  }
  return { samples: out, ideal };
}
/* where the groove is, measured on the finished solid: the floor under the drawn line, and the width at the surface */
function grooveFit(ctx, soup, ideal, surf, depth, expectHW) {
  let edge = 0, floor = 0, n = 0, miss = 0;
  for (let i = 3; i < ideal.length - 3; i += 4) {
    const m = ideal[i];
    let tan = sub3(ideal[i + 1].p, ideal[i - 1].p); const Lt = Math.hypot(...tan); if (Lt < 1e-9) continue;
    tan = mul3(tan, 1 / Lt);
    const lat = norm3(cross3(m.n, tan));
    const h0 = ctx.NSO_rayHitsSoup(soup, ...add3(m.p, mul3(m.n, 3)), ...mul3(m.n, -1));
    if (h0.length) floor = Math.max(floor, Math.abs(h0[0] - 3 - depth));
    for (const sg of [1, -1]) {
      let found = null;
      for (let x = 0.2; x < expectHW + 1.6; x += 0.04) {
        const o = surf.offset ? surf.offset(m.p, m.n, mul3(lat, sg), x) : { q: add3(m.p, mul3(lat, sg * x)), nq: m.n };
        const h = ctx.NSO_rayHitsSoup(soup, ...add3(o.q, mul3(o.nq, 3)), ...mul3(o.nq, -1));
        if ((h.length ? h[0] - 3 : 0) < 0.03) { found = x; break; }
      }
      if (found === null) { miss++; continue; }
      edge = Math.max(edge, Math.abs(found - expectHW)); n++;
    }
  }
  return { edge, floor, n, miss };
}
async function cutThroughKernel(ctx, wasm, hull, planned) {
  const A = ctx.NSO_CSG.soupToManifold(wasm, hull);
  const parts = planned.pieces.map(q => ctx.NSO_CSG.soupToManifold(wasm, q)), temps = [];
  let level = parts.slice();
  while (level.length > 1) {
    const nx = [];
    for (let i = 0; i + 1 < level.length; i += 2) { const u = level[i].add(level[i + 1]); temps.push(u); nx.push(u); }
    if (level.length % 2) nx.push(level[level.length - 1]);
    level = nx;
  }
  const R = A.subtract(level[0]);
  const out = { status: R.status(), soup: ctx.NSO_CSG.manifoldToSoup(R), stats: ctx.NSO_manifoldStats(R), removed: A.volume() - R.volume() };
  [A, R, ...parts, ...temps].forEach(m => m.delete());
  return out;
}
async function part1d() {
  console.log('\n--- 1d. a drawn curve is cut as drawn: U, S and long arcs, plane and sphere ---');
  const ctx = csgContext();
  const wasm = await ctx.NSO_CSG.load();
  const BL = {
    ball: { params: { radius: 2, height: 8 }, hw: d => Math.sqrt(4 - (2 - d) * (2 - d)) },
    flat: { params: { width: 4, length: 6, height: 8 }, hw: () => 2 },
    vee: { params: { angle: 90, length: 6, height: 8 }, hw: d => d * Math.tan(Math.PI / 4) }
  };
  /* the width is read by stepping outward 0.04 mm at a time, and a sphere sags 0.04 mm across a 4 mm blade: 0.15 is
     three of those steps, not a looseness in the cut (it measures 0.03-0.12) */
  const FIT = 0.15, depth = 1;
  const cases = [
    ['U r6, steady', PLANE, DRAW.U(6), 300, 0, 0], ['U r4, 0.2 mm pixels', PLANE, DRAW.U(4), 300, 0, 0.2],
    ['S, 0.2 mm pixels', PLANE, DRAW.S(10), 300, 0, 0.2], ['S, shaky + pixels', PLANE, DRAW.S(10), 400, 0.2, 0.2],
    ['190 mm arc', PLANE, DRAW.arc(40), 700, 0, 0.2],
    ['arc on a sphere R50', sphereOf(50), DRAW.arc(20), 400, 0, 0.1], ['U on a sphere R30', sphereOf(30), DRAW.U(6), 300, 0, 0.1],
    ['S on a sphere R50, shaky', sphereOf(50), DRAW.S(10), 400, 0.1, 0.1]
  ];
  for (const [label, surf, shape, n, shake, grid] of cases) {
    for (const name of Object.keys(BL)) {
      const d = drawn(surf, shape, n, shake, grid);
      let drawnLen = 0;
      for (let i = 1; i < d.ideal.length; i++) drawnLen += Math.hypot(...sub3(d.ideal[i].p, d.ideal[i - 1].p));
      const pl = NSO_Carve.planStroke(surf.hull, d.samples, name, BL[name].params, { depth });
      if (!check(name + ', ' + label + ': planned (not refused)', pl.ok, pl.ok ? pl.segments + ' segments, ' + pl.joints + ' joints' : pl.reason)) continue;
      check('  ... as long as it was drawn (' + drawnLen.toFixed(1) + ' mm)', near(pl.length, drawnLen, 0.03 * drawnLen),
        pl.length.toFixed(1) + ' mm');
      const cut = await cutThroughKernel(ctx, wasm, surf.hull, pl);
      check('  ... cuts to a valid solid', cut.status === 'NoError' && cut.stats.open === 0 && cut.stats.nm === 0 && cut.removed > 0,
        cut.status + ', open ' + cut.stats.open + ', nm ' + cut.stats.nm + ', ' + cut.removed.toFixed(1) + ' mm^3');
      const fit = grooveFit(ctx, cut.soup, d.ideal, surf, depth, BL[name].hw(depth));
      check('  ... where it was drawn: floor within ' + FIT + ' mm, width within ' + FIT + ' mm',
        fit.n > 20 && fit.miss === 0 && fit.floor <= FIT && fit.edge <= FIT,
        'floor ' + fit.floor.toFixed(3) + ', width ' + fit.edge.toFixed(3) + ' (' + fit.n + ' edges read, ' + fit.miss + ' missed)');
    }
  }
  /* a turn tighter than the blade is wide: the sweep used to refuse it, then to flatten it; the union has no limit to hit */
  for (const name of Object.keys(BL)) {
    const d = drawn(PLANE, DRAW.U(1.2), 200, 0, 0.1);
    const pl = NSO_Carve.planStroke(PLANE.hull, d.samples, name, BL[name].params, { depth: 1.5 });
    if (!check(name + ': a U of 1.2 mm radius (tighter than the blade) is planned', pl.ok, pl.ok ? pl.segments + ' segments' : pl.reason)) continue;
    const cut = await cutThroughKernel(ctx, wasm, PLANE.hull, pl);
    check('  ... and cuts to a valid solid', cut.status === 'NoError' && cut.stats.open === 0 && cut.stats.nm === 0 && cut.removed > 0,
      cut.status + ', open ' + cut.stats.open + ', nm ' + cut.stats.nm);
  }
  console.log('\n--- 1e. one smooth surface, many faces: an edge is still an edge ---');
  {
    const a = drawn(PLANE, t => [-20 + 20 * t, 0], 40, 0, 0).samples;
    const bsm = Array.from({ length: 41 }, (_, i) => ({ point: [0, 20 - 20 * i / 40, 0], normal: [1, 0, 0] })).slice(1);
    const r = NSO_Carve.planStroke(PLANE.hull, a.concat(bsm), 'ball', BL.ball.params, { depth: 1 });
    check('a stroke from the top of a box over its edge down the side is refused in words', !r.ok && /crosses onto another face/.test(r.reason), r.reason);
    const s = drawn(sphereOf(20), DRAW.arc(10), 300, 0, 0.1);
    const r2 = NSO_Carve.planStroke(sphereOf(20).hull, s.samples, 'ball', BL.ball.params, { depth: 1 });
    check('a 270-degree arc on a sphere (its normals spread 57 degrees, past the old 25 degree limit) is not an edge', r2.ok, r2.ok ? r2.segments + ' segments' : r2.reason);
  }
}

/* ============================================================
   PART 2 - a real drag
   ============================================================ */
const setControls = (page, o) => page.evaluate(o => window.nsoCarveSetControls(o), o);
const soupOf = (page, id) => page.evaluate(id => {
  const p = state.placed.find(q => q && q.sourceId === id && q.mesh);
  p.mesh.updateMatrixWorld(true);
  return Array.from(meshToWorldSoup(p.mesh));
}, id);
const worldBox = (page, id) => page.evaluate(id => {
  const p = state.placed.find(q => q && q.sourceId === id && q.mesh);
  p.mesh.updateMatrixWorld(true);
  const bb = new THREE.Box3().setFromObject(p.mesh);
  return { min: bb.min.toArray(), max: bb.max.toArray() };
}, id);
const statusOf = page => page.evaluate(() => document.getElementById('status').textContent);

/* Look straight down on a point, then map world points to page pixels. */
async function lookDown(page, at, height) {
  await page.evaluate(([at, h]) => {
    state.camera.position.set(at[0], at[1] + h, at[2] + 1e-3);
    state.camera.up.set(0, 0, -1);
    if (state.controls) { state.controls.target.set(at[0], at[1], at[2]); state.controls.update(); }
    state.camera.lookAt(at[0], at[1], at[2]);
    state.camera.updateMatrixWorld(true);
    if (state.renderer && state.scene) state.renderer.render(state.scene, state.camera);
  }, [at, height]);
}
const toScreen = (page, pts) => page.evaluate(pts => {
  const r = state.renderer.domElement.getBoundingClientRect();
  return pts.map(p => {
    const v = new THREE.Vector3(p[0], p[1], p[2]).project(state.camera);
    const x = r.left + (v.x + 1) / 2 * r.width, y = r.top + (1 - v.y) / 2 * r.height;
    const el = document.elementFromPoint(x, y);
    return { x, y, canvas: el === state.renderer.domElement };
  });
}, pts);
async function settle(page) {
  await page.waitForFunction(() => !window.nsoCarveBusy(), null, { timeout: 60000 });
  return page.evaluate(() => {
    const r = window.nsoCarveLast;
    if (!r) return null;
    const pl = r.planned && r.planned.ok ? r.planned : null;
    return {
      ok: r.ok, stroke: !!r.stroke, reason: r.reason, status: r.status, removed: r.removed, intended: r.intended,
      kind: pl && pl.probe ? pl.probe.kind : null,
      surface: pl && pl.surface ? pl.surface : null, outward: pl && pl.outward ? pl.outward : null,
      length: pl && pl.length, segments: pl && pl.segments,
      profile: pl && pl.section ? pl.section.profile : null, hw: pl && pl.section ? pl.section.halfWidth : null,
      wall: r.wall ? { ok: r.wall.ok, thinnest: r.wall.thinnest_mm, floor: r.wall.floor_mm, reason: r.wall.reason } : null
    };
  });
}
async function drag(page, a, b, steps) {
  const [sa, sb] = await toScreen(page, [a, b]);
  await page.evaluate(() => { window.nsoCarveLast = null; });
  await page.mouse.move(sa.x, sa.y);
  await page.mouse.down();
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(sa.x + (sb.x - sa.x) * i / steps, sa.y + (sb.y - sa.y) * i / steps);
  }
  await page.mouse.up();
  return { sa, sb, r: await settle(page) };
}

async function part2() {
  console.log('\n=== Part 2: a real pointer drag, real app, real kernel ===');
  await withApp(async (page, logs) => {
    const id = await loadSTL(page, path.join(ROOT, 'fixtures', 'box_hull_80x40x20-2.stl'));
    await selectModel(page, id);
    const B = await worldBox(page, id);
    const top = B.max[1];
    const cx = (B.min[0] + B.max[0]) / 2, cz = (B.min[2] + B.max[2]) / 2;
    await page.evaluate(() => {
      document.querySelectorAll('details[open]').forEach(d => { d.open = false; });
      if (!state.carveArmed) document.getElementById('btn-carve').click();
    });
    check('Carve is armed', await page.evaluate(() => state.carveArmed === true));

    console.log('\n--- 2c. Carve\'s four numbers are sliders, and each says what it is set to ---');
    {
      const rd = () => page.evaluate(() => ['carve-depth', 'carve-a', 'carve-b', 'carve-roll'].map(id => {
        const el = document.getElementById(id), r = el.getBoundingClientRect();
        return { id, type: el.type, label: document.getElementById(id + '-label').textContent,
                 read: document.getElementById(id + '-read').textContent, shown: !el.closest('label').hidden && r.width > 0,
                 min: el.min, max: el.max };
      }));
      await page.evaluate(() => { document.getElementById('menu-sculpt').open = true; });
      await setControls(page, { blade: 'flat', a: 4, b: 6, depth: 1, roll: 0 });
      let c = await rd();
      check('depth, width, length and roll are range sliders, all shown for a slab', c.every(x => x.type === 'range' && x.shown),
        c.map(x => x.id + ':' + x.type + (x.shown ? '' : ' hidden')).join(', '));
      check('  ... labelled in words, each with its value and unit beside it',
        c.map(x => x.label + ' ' + x.read).join(' | ') === 'Depth 1 mm | Width 4 mm | Length 6 mm | Roll 0°', c.map(x => x.label + ' ' + x.read).join(' | '));
      /* a real user input on the depth slider: the read-out and the blade line follow it */
      await page.evaluate(() => { const d = document.getElementById('carve-depth'); d.value = '2.5'; d.dispatchEvent(new Event('input', { bubbles: true })); });
      c = await rd();
      const line = await page.evaluate(() => document.getElementById('carve-readout').textContent);
      check('  ... moving Depth moves its read-out and the blade line', c[0].read === '2.5 mm' && /cutting 2\.5 mm deep/.test(line), c[0].read + ' / ' + line);
      await setControls(page, { blade: 'ball', a: 2, depth: 1, roll: 0 });
      c = await rd();
      check('a ball-nose shows Radius and no Length slider', c[1].label === 'Radius' && c[1].read === '2 mm' && !c[2].shown, c.map(x => x.label + (x.shown ? '' : ' (hidden)')).join(', '));
      await setControls(page, { blade: 'vee', a: 90, b: 6, depth: 1, roll: 0 });
      c = await rd();
      check('a V-groove shows Angle in degrees and Length', c[1].label === 'Angle' && c[1].read === '90°' && c[2].shown && c[2].read === '6 mm', c.map(x => x.label + ' ' + x.read).join(' | '));
      /* the card stays open: shutting Sculpt puts Carve away, and the drags below need it armed */
    }
    await lookDown(page, [cx, top, cz], 140);

    console.log('\n--- 2d. a 20 mm drag cuts one groove of the blade\'s section ---');
    const cases = [
      { label: 'ball-nose', ctl: { blade: 'ball', a: 2, depth: 1.5 }, z: cz - 10 },
      { label: 'flat shave', ctl: { blade: 'flat', a: 4, b: 6, depth: 1 }, z: cz },
      { label: 'V-groove', ctl: { blade: 'vee', a: 90, b: 6, depth: 1.5 }, z: cz + 10 }
    ];
    const undoSoups = [];
    for (const c of cases) {
      await setControls(page, Object.assign({ roll: 0 }, c.ctl));
      const before = await soupOf(page, id);
      const a = [cx - 10, top, c.z], b = [cx + 10, top, c.z];
      const { sa, sb, r } = await drag(page, a, b, 30);
      check(c.label + ': the drag lands on the canvas', sa.canvas && sb.canvas,
        '(' + sa.x.toFixed(1) + ',' + sa.y.toFixed(1) + ') -> (' + sb.x.toFixed(1) + ',' + sb.y.toFixed(1) + ')');
      check('  ... and cuts a groove, not a punch', r && r.ok && r.stroke, r ? (r.status || r.reason) : 'no result');
      if (!r || !r.ok || !r.stroke) continue;
      check('  ... 20 mm long, one straight segment', near(r.length, 20, 0.05) && r.segments === 1,
        r.length.toFixed(4) + ' mm, ' + r.segments + ' segment');
      check('  ... removing exactly what the groove meets', near(r.removed, r.intended, 1e-3),
        r.removed.toFixed(4) + ' of ' + r.intended.toFixed(4) + ' mm^3');
      const area = NSO_PathSweep.polyArea(expectedGroove(r.profile, c.ctl.depth).concat([[0, c.ctl.depth]]));
      check('  ... which is at least the section x the stroke', r.removed >= Math.abs(area) * r.length - 1e-3,
        r.removed.toFixed(3) + ' >= ' + (Math.abs(area) * r.length).toFixed(3) + ' mm^3');
      check('  ... with the wall gate\'s reading on the line', /wall: (thinnest wall left|no surface within [\d.]+ mm of the groove)/.test(r.status), r.status);

      const after = await soupOf(page, id);
      const soup = Float32Array.from(after);
      const g = gate(soup, 'drag_' + c.ctl.blade);
      check('  ... and the piece gates clean (manifold)', clean(g), gsum(g));

      /* the section, every 0.5 mm along the whole stroke */
      const start = r.surface[0], end = r.surface[r.surface.length - 1];
      const u = norm3(sub3(end, start)), Y = r.outward;
      const expected = expectedGroove(r.profile, c.ctl.depth);
      let worstA = 0, worstB = 0, stations = 0, bad = null;
      for (let s = 0.25; s <= r.length - 0.25 + 1e-9; s += 0.5) {
        const m = sectionAt(soup, start, u, Y, c.ctl.depth, expected, r.hw, s);
        if (!m.ok) { bad = s.toFixed(2) + ' mm: ' + m.why; break; }
        stations++;
        worstA = Math.max(worstA, m.cutToBlade);
        worstB = Math.max(worstB, m.bladeToCut);
      }
      check('  ... the section at every 0.5 mm along it is the blade\'s, within ' + SECTION_TOL + ' mm',
        !bad && stations >= 39 && worstA <= SECTION_TOL && worstB <= SECTION_TOL,
        bad || (stations + ' stations, cut->blade ' + worstA.toFixed(4) + ' mm, blade->cut ' + worstB.toFixed(4) + ' mm'));
      if (c.ctl.blade === 'ball') {
        /* and against the true circle, not just the faceted blade */
        let worstR = 0;
        for (let s = 0.25; s <= r.length - 0.25 + 1e-9; s += 0.5) {
          const X = cross3(Y, u);
          const at = [start[0] + u[0] * s, start[1] + u[1] * s, start[2] + u[2] * s];
          for (const l of NSO_PathSweep.sectionLoops(soup, at, u) || []) {
            for (const p of l) {
              const d = sub3(p, at), x = dot3(d, X), y = dot3(d, Y) + c.ctl.depth;
              if (y < c.ctl.depth - 1e-3 && Math.abs(x) < 2.5) worstR = Math.max(worstR, Math.abs(Math.hypot(x, y - 2) - 2));
            }
          }
        }
        check('  ... and the ball-nose floor is the r 2 mm circle within ' + SECTION_TOL + ' mm', worstR <= SECTION_TOL,
          'worst radial error ' + worstR.toFixed(4) + ' mm');
      }
      undoSoups.push({ label: c.label, before });
    }

    /* an oblique look down the grooves, so the three sections read at their ends */
    await page.evaluate(([at]) => {
      state.camera.up.set(0, 1, 0);
      state.camera.position.set(at[0] + 38, at[1] + 26, at[2] + 30);
      if (state.controls) { state.controls.target.set(at[0] + 4, at[1] - 2, at[2]); state.controls.update(); }
      state.camera.lookAt(at[0] + 4, at[1] - 2, at[2]);
      state.camera.updateMatrixWorld(true);
      state.renderer.render(state.scene, state.camera);
    }, [[cx, top, cz]]);
    const shotDir = path.join(ROOT, 'tools', 'carve-out');
    fs.mkdirSync(shotDir, { recursive: true });
    await page.screenshot({ path: path.join(shotDir, 'carve-drag.png') });
    await lookDown(page, [cx, top, cz], 140);

    console.log('\n--- 2d. one Undo per stroke puts the piece back, vertex for vertex ---');
    for (let i = undoSoups.length - 1; i >= 0; i--) {
      await page.evaluate(() => undoLast());
      const st = await statusOf(page);
      const now = await soupOf(page, id);
      const was = undoSoups[i].before;
      let worst = now.length === was.length ? 0 : Infinity;
      for (let k = 0; k < Math.min(now.length, was.length); k++) worst = Math.max(worst, Math.abs(now[k] - was[k]));
      check(undoSoups[i].label + ': one Undo restores it exactly, and says Carve',
        worst === 0 && st === 'Undo: Carve reverted', st + ', worst delta ' + worst);
    }

    console.log('\n--- 2d2. a curved drag is one groove too ---');
    {
      await setControls(page, { blade: 'ball', a: 1.5, depth: 1, roll: 0 });
      const before = await soupOf(page, id);
      const arc = Array.from({ length: 41 }, (_, i) => {
        const t = Math.PI * (0.15 + 0.7 * i / 40);
        return [cx - 25 + 12 * Math.cos(t), top, cz + 6 - 12 * Math.sin(t)];
      });
      const sp = await toScreen(page, arc);
      await page.evaluate(() => { window.nsoCarveLast = null; });
      await page.mouse.move(sp[0].x, sp[0].y);
      await page.mouse.down();
      for (const q of sp.slice(1)) await page.mouse.move(q.x, q.y);
      await page.mouse.up();
      const r = await settle(page);
      check('a 126-degree arc drag cuts one groove', r && r.ok && r.stroke,
        r ? (r.status || r.reason) : 'no result');
      if (r && r.ok) {
        check('  ... along the arc (' + r.segments + ' segments, ' + r.length.toFixed(1) + ' mm)',
          r.segments > 1 && near(r.length, 12 * Math.PI * 0.7, 0.5), r.length.toFixed(3) + ' mm vs ' + (12 * Math.PI * 0.7).toFixed(3));
        const g = gate(Float32Array.from(await soupOf(page, id)), 'drag_arc');
        check('  ... and the piece gates clean', clean(g), gsum(g));
        await page.evaluate(() => undoLast());
        const now = await soupOf(page, id);
        check('  ... and one Undo takes the whole arc back', now.length === before.length && now.every((v, i) => v === before[i]));
      }
    }


    console.log('\n--- 2d3. a hand-drawn S, with a real pointer, is cut where it was drawn ---');
    {
      const ctx = csgContext();
      const S_PTS = Array.from({ length: 121 }, (_, i) => { const t = i / 120; return [cx + 50 * (t - 0.5), top, cz + 8 * Math.sin(2 * Math.PI * t)]; });
      let drawnLen = 0;
      for (let i = 1; i < S_PTS.length; i++) drawnLen += Math.hypot(...sub3(S_PTS[i], S_PTS[i - 1]));
      const ideal = S_PTS.map(q => ({ p: q, n: [0, 1, 0] }));
      for (const c of [
        { label: 'ball-nose', ctl: { blade: 'ball', a: 2, depth: 1 }, hw: Math.sqrt(3) },
        { label: 'flat shave', ctl: { blade: 'flat', a: 4, b: 6, depth: 1 }, hw: 2 },
        { label: 'V-groove', ctl: { blade: 'vee', a: 90, b: 6, depth: 1 }, hw: 1 }
      ]) {
        await setControls(page, Object.assign({ roll: 0 }, c.ctl));
        const before = await soupOf(page, id);
        const sp = await toScreen(page, S_PTS);
        await page.evaluate(() => { window.nsoCarveLast = null; });
        await page.mouse.move(sp[0].x, sp[0].y);
        await page.mouse.down();
        for (const q of sp.slice(1)) await page.mouse.move(q.x, q.y);
        await page.mouse.up();
        const r = await settle(page);
        check(c.label + ': a ' + drawnLen.toFixed(0) + ' mm S cuts one groove', r && r.ok && r.stroke, r ? (r.status || r.reason) : 'no result');
        if (!r || !r.ok) continue;
        check('  ... as long as it was drawn, not straightened into a Z or a V (' + r.segments + ' segments)',
          r.segments > 8 && near(r.length, drawnLen, 0.03 * drawnLen), r.length.toFixed(1) + ' mm vs ' + drawnLen.toFixed(1));
        const soup = Float32Array.from(await soupOf(page, id));
        const g = gate(soup, 'drag_S_' + c.ctl.blade);
        check('  ... the piece gates clean', clean(g), gsum(g));
        /* a screen pixel here is ~0.1-0.2 mm, so the drawing itself is only that exact */
        const fit = grooveFit(ctx, soup, ideal, {}, c.ctl.depth, c.hw);
        check('  ... and the groove is where the pointer went: floor and width within 0.25 mm',
          fit.n > 20 && fit.miss === 0 && fit.floor <= 0.25 && fit.edge <= 0.25,
          'floor ' + fit.floor.toFixed(3) + ', width ' + fit.edge.toFixed(3) + ' (' + fit.n + ' edges read, ' + fit.miss + ' missed)');
        await page.evaluate(() => undoLast());
        const now = await soupOf(page, id);
        check('  ... and one Undo takes it back', now.length === before.length && now.every((v, k) => v === before[k]));
      }
    }

    console.log('\n--- 2e. a click that does not move still punches ---');
    await setControls(page, { blade: 'ball', a: 2, depth: 1, roll: 0 });
    const [pc] = await toScreen(page, [[cx, top, cz]]);
    await page.evaluate(() => { window.nsoCarveLast = null; });
    await page.mouse.click(pc.x, pc.y);
    const k = await settle(page);
    check('a still click punches once, as before', k && k.ok && !k.stroke && k.kind === 'face',
      k ? (k.status || k.reason) : 'no result');
    check('  ... removing exactly blade n piece', k && near(k.removed, k.intended, 1e-3),
      k ? k.removed.toFixed(4) + ' of ' + k.intended.toFixed(4) + ' mm^3' : '-');
    await page.evaluate(() => undoLast());

    console.log('\n--- 2f. a groove that would leave under two nozzle widths is refused ---');
    const idH = await loadSTL(page, path.join(ROOT, 'fixtures', 'box_open.stl'));
    await selectModel(page, idH);
    const H = await worldBox(page, idH);
    const hx = (H.min[0] + H.max[0]) / 2, hz = (H.min[2] + H.max[2]) / 2;
    /* the tray's floor, from underneath - the same 2 mm floor nso_carve_test.js 2i3 measures */
    const under = line([hx - 8, H.min[1], hz], [hx + 8, H.min[1], hz], 32, [0, -1, 0]);
    const wall = await page.evaluate(([id, pt]) => {
      const p = state.placed.find(q => q && q.sourceId === id && q.mesh);
      p.mesh.updateMatrixWorld(true);
      return NSO_Thickness.prepare(meshToWorldSoup(p.mesh), {}).wallAt(pt).mm;
    }, [idH, [hx, H.min[1], hz]]);
    check('the floor under the stroke is 2 mm', near(wall, 2, 1e-3), wall + ' mm');
    const trayBefore = await soupOf(page, idH);
    await setControls(page, { blade: 'ball', a: 0.8, depth: 1.5, roll: 0 });
    let s = await page.evaluate(([id, sm]) => window.nsoCarveStrokeAt(id, sm).then(r => ({
      ok: r.ok, reason: r.reason, stroke: r.stroke })), [idH, under]);
    check('a 1.5 mm groove into the 2 mm floor (leaves 0.5) is refused', !s.ok && s.stroke, s.reason);
    check('  ... in words: the wall, what it leaves, two nozzle widths, Thicken first',
      /leaves 0\.5 mm/.test(s.reason) && /two 0\.4 mm nozzle widths/.test(s.reason) && /Thicken first/.test(s.reason), s.reason);
    const trayAfter = await soupOf(page, idH);
    check('  ... and the piece is untouched', trayAfter.length === trayBefore.length &&
      trayAfter.every((v, i) => v === trayBefore[i]));
    check('  ... and the status line says so', (await statusOf(page)) === s.reason, await statusOf(page));
    await setControls(page, { blade: 'ball', a: 0.8, depth: 1.15, roll: 0 });
    s = await page.evaluate(([id, sm]) => window.nsoCarveStrokeAt(id, sm).then(r => ({
      ok: r.ok, reason: r.reason || r.status, soup: null })), [idH, under]);
    check('a 1.15 mm groove into it (leaves 0.85) is cut', s.ok, s.reason);
    if (s.ok) {
      const g = gate(Float32Array.from(await soupOf(page, idH)), 'tray_groove');
      check('  ... and the tray gates clean', clean(g), gsum(g));
    }


    console.log('\n--- 2g. a long curved line across a curved face is cut, not refused ---');
    {
      const ctx = csgContext();
      const idS = await loadSTL(page, path.join(ROOT, 'fixtures', 'fixture_sphere_curved.stl'));
      await selectModel(page, idS);
      const Bs = await worldBox(page, idS);
      const C0 = [0, 1, 2].map(k => (Bs.min[k] + Bs.max[k]) / 2), Rs = (Bs.max[1] - Bs.min[1]) / 2;
      await lookDown(page, [C0[0], Bs.max[1], C0[2]], 60);
      /* an S laid on the sphere's upper cap, 18 mm across and swinging 3 mm: it runs 52 degrees down the cap, so the
         surface turns ~50 degrees along it - twice what one fixed blade angle allowed */
      const onSphere = (u, v) => { const th = Math.hypot(u, v) / Rs, ph = Math.atan2(v, u);
        const n = [Math.sin(th) * Math.cos(ph), Math.cos(th), Math.sin(th) * Math.sin(ph)];
        return { p: [C0[0] + Rs * n[0], C0[1] + Rs * n[1], C0[2] + Rs * n[2]], n }; };
      const ideal = Array.from({ length: 121 }, (_, i) => { const t = i / 120; return onSphere(18 * (t - 0.5), 3 * Math.sin(2 * Math.PI * t)); });
      let drawnLen = 0;
      for (let i = 1; i < ideal.length; i++) drawnLen += Math.hypot(...sub3(ideal[i].p, ideal[i - 1].p));
      await setControls(page, { blade: 'ball', a: 0.8, depth: 0.5, roll: 0 });
      const before = await soupOf(page, idS);
      const sp = await toScreen(page, ideal.map(m => m.p));
      check('the line lies on the canvas', sp.every(q => q.canvas), sp.filter(q => !q.canvas).length + ' points off it');
      await page.evaluate(() => { window.nsoCarveLast = null; });
      await page.mouse.move(sp[0].x, sp[0].y);
      await page.mouse.down();
      for (const q of sp.slice(1)) await page.mouse.move(q.x, q.y);
      await page.mouse.up();
      const r = await settle(page);
      check('a ' + drawnLen.toFixed(0) + ' mm S across a sphere cuts one groove', r && r.ok && r.stroke, r ? (r.status || r.reason) : 'no result');
      if (r && r.ok) {
        check('  ... following the line (' + r.segments + ' segments)', r.segments > 6 && near(r.length, drawnLen, 0.05 * drawnLen),
          r.length.toFixed(1) + ' mm vs ' + drawnLen.toFixed(1));
        const soup = Float32Array.from(await soupOf(page, idS));
        const g = gate(soup, 'drag_sphere_S');
        check('  ... the sphere gates clean', clean(g), gsum(g));
        /* the floor lies the depth below the surface along the line: on a faceted sphere, within a facet's sag */
        let worst = 0, n = 0;
        for (let i = 8; i < ideal.length - 8; i += 4) {
          const m = ideal[i];
          const h = ctx.NSO_rayHitsSoup(soup, ...add3(m.p, mul3(m.n, 3)), ...mul3(m.n, -1));
          if (h.length) { worst = Math.max(worst, Math.abs(h[0] - 3 - 0.5)); n++; }
        }
        check('  ... and its floor is 0.5 mm under the surface all along the line (within 0.15 mm)', n > 20 && worst <= 0.15,
          'worst ' + worst.toFixed(3) + ' mm over ' + n + ' points');
        await page.evaluate(() => undoLast());
        const now = await soupOf(page, idS);
        check('  ... and one Undo takes it back', now.length === before.length && now.every((v, k) => v === before[k]));
      }
    }

    const errs = logs.filter(l => /pageerror/.test(l));
    check('no page errors anywhere in the run', errs.length === 0, errs.slice(0, 2).join(' | ') || 'none');
  });
}

(async () => {
  part1();
  await part1d();
  await part2();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('\n' + (fails ? fails + ' FAILED' : 'all carve:drag gates held'));
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
