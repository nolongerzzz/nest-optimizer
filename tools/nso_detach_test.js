/* nso_detach.js - Detach a detected flange, Reattach it elsewhere.
   node tools/nso_detach_test.js        exit 0 = every gate held

   READ docs/DETACH.md for what these numbers mean.

   The real case is library/v9_mirror_factory.stl, the clamp bar: its 2.94 mm
   flange comes off the -Y neck wall along the whole 187 mm bar, across both
   Mirror-Join seams. The gates below say, in order:

     1. the audit. What detection already gives (the plane) and what it did
        not (where the wall steps), measured. Why one cut cannot cap the
        hull cleanly. What Assemble's attach needed to take a real piece:
        the foot, the twist, and the length.
     2. Detach on v9. The hull passes the canonical checker with
        self-intersection, stands 0 um past its own wall, and is the source
        away from the root. The flange is the Flange tab's flange, bit for
        bit, in Assemble's frame. The volumes add up to the micron.
     3. Reattach on v9 at the mirror-opposite position. One solid, PASS with
        self-intersection, the piece meets the body at its seat only, and
        NO triangle of the result is off the two input surfaces: nothing was
        bridged or sampled. Set against Crop stage 2's recorded result for
        the same relocation.
     4. the same with the part turned (an axis-aligned turn and an off-axis one).
     5. synthetic shapes: a lip on a block, a T section, a hat section.
     6. refusals, each by name.

   The union is the shipped one (tools/nso_csg_node.js splices app-join.js). */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(__dirname, 'detach-out');
const { readSTL, writeSTL } = require('./nso_stl_io.js');
const { csgContext } = require('./nso_csg_node.js');

const ctx = {
  Math, Map, Set, console, Array, Object, Number, String, JSON, isFinite, isNaN, parseFloat, parseInt,
  Float32Array, Float64Array, Int32Array, Uint32Array, Uint8Array, Uint16Array, ArrayBuffer, Error,
  Infinity, NaN, Date, Promise, RegExp, Boolean, Symbol,
  NSO_Thickness: require(path.join(ROOT, 'nso_thickness.js'))
};
ctx.window = ctx;
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext('var state = {}; var THREE = {};', ctx);
for (const f of ['app-cut.js', 'nso_planar_fuse.js', 'app-crop.js', 'nso_seat_surface.js', 'app-sculpt.js',
                 'app-finish.js', 'app-extend.js', 'nso_support_aim.js', 'nso_assemble.js', 'nso_flange.js',
                 'nso_detach.js']) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
}
const { rawCut, NSO_Flange: F, NSO_Detach: DT, NSO_Assemble: AS, NSO_SupportAim: SA } = ctx;
const CSG = csgContext();

let pass = 0, fail = 0;
const FAILS = [];
function check(name, cond, detail) {
  if (cond) pass++; else { fail++; FAILS.push(name); }
  console.log('  ' + (cond ? 'ok    ' : 'FAIL  ') + name + (detail ? '   ' + detail : ''));
}
const f3 = (x) => Number(x).toFixed(3);
const um = (x) => (x * 1000).toFixed(2) + ' um';

fs.mkdirSync(OUT, { recursive: true });
let seq = 0;
function validate(soup, name, selfint) {
  const f = path.join(OUT, (name || 'p' + seq++) + '.stl');
  writeSTL(f, soup);
  const args = [path.join(ROOT, 'tools', 'mesh_validate.py'), f, '--json'];
  if (!selfint) args.push('--no-selfint');
  const j = JSON.parse(execFileSync('python3', args, { maxBuffer: 64 << 20 }).toString());
  const si = j.self_intersection;
  j.summary = j.verdict + ' open ' + j.open_edges + ' nm ' + j.nonmanifold_edges + ' inc ' +
    j.inconsistent_winding_edges + ' chi ' + j.euler_characteristic +
    (si ? ' pierce ' + si.pierce + ' coplanar ' + si.coplanar : '');
  j.clean = j.verdict === 'PASS' && (!si || (si.pierce === 0 && si.coplanar === 0));
  return j;
}
function bounds(s) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < s.length; i++) { const k = i % 3; if (s[i] < lo[k]) lo[k] = s[i]; if (s[i] > hi[k]) hi[k] = s[i]; }
  return { lo, hi };
}
const volume = (s) => ctx.NSO_cropVolume(s);
function triArea(s, o) {
  const ux = s[o + 3] - s[o], uy = s[o + 4] - s[o + 1], uz = s[o + 5] - s[o + 2];
  const vx = s[o + 6] - s[o], vy = s[o + 7] - s[o + 1], vz = s[o + 8] - s[o + 2];
  return 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
}
function rot(s, ax, deg) {
  const c = Math.cos(deg * Math.PI / 180), n = Math.sin(deg * Math.PI / 180), o = new Float32Array(s.length);
  for (let i = 0; i < s.length; i += 3) {
    let x = s[i], y = s[i + 1], z = s[i + 2];
    if (ax === 'z') [x, y] = [c * x - n * y, n * x + c * y];
    if (ax === 'x') [y, z] = [c * y - n * z, n * y + c * z];
    o[i] = x; o[i + 1] = y; o[i + 2] = z;
  }
  return o;
}
/* The first point of `soup` hit by a ray, or null. SupportAim's own ray test. */
function castTo(soup, from, dir, far) {
  const t = SA._nearestHit([soup], from, dir, 0, far || 100);
  return t > 0 ? [from[0] + dir[0] * t, from[1] + dir[1] * t, from[2] + dir[2] * t] : null;
}

/* How far each triangle of `out` lies from the nearest triangle of the given
   input surfaces (centroid to triangle, a uniform grid over the inputs).
   A union of two solids is made of pieces of their two surfaces and nothing
   else. A bridge, a fillet, a sampled field is not. */
function offSurface(out, inputs, tol) {
  const cell = 2, grid = new Map(), tris = [];
  inputs.forEach((s) => { for (let o = 0; o + 8 < s.length; o += 9) tris.push([s, o]); });
  const key = (i, j, k) => i + ',' + j + ',' + k;
  tris.forEach((T, id) => {
    const s = T[0], o = T[1];
    const lo = [0, 1, 2].map((k) => Math.floor(Math.min(s[o + k], s[o + 3 + k], s[o + 6 + k]) / cell));
    const hi = [0, 1, 2].map((k) => Math.floor(Math.max(s[o + k], s[o + 3 + k], s[o + 6 + k]) / cell));
    for (let i = lo[0]; i <= hi[0]; i++) for (let j = lo[1]; j <= hi[1]; j++) for (let k = lo[2]; k <= hi[2]; k++) {
      const kk = key(i, j, k); let L = grid.get(kk); if (!L) grid.set(kk, L = []); L.push(id);
    }
  });
  let off = 0, worst = 0, offArea = 0;
  for (let o = 0; o + 8 < out.length; o += 9) {
    const c = [(out[o] + out[o + 3] + out[o + 6]) / 3, (out[o + 1] + out[o + 4] + out[o + 7]) / 3,
               (out[o + 2] + out[o + 5] + out[o + 8]) / 3];
    const L = grid.get(key(Math.floor(c[0] / cell), Math.floor(c[1] / cell), Math.floor(c[2] / cell))) || [];
    let best = Infinity;
    for (const id of L) {
      const s = tris[id][0], p = tris[id][1];
      const q = SA._closestOnTri(c, [s[p], s[p + 1], s[p + 2]], [s[p + 3], s[p + 4], s[p + 5]], [s[p + 6], s[p + 7], s[p + 8]]);
      const d = Math.hypot(q[0] - c[0], q[1] - c[1], q[2] - c[2]);
      if (d < best) best = d;
      if (best <= tol) break;
    }
    if (best > tol) { off++; offArea += triArea(out, o); }
    if (best > worst && isFinite(best)) worst = best;
  }
  return { off, offArea, worst, tris: out.length / 9 };
}

// --- synthetic shapes (the same helpers tools/nso_flange_test.js uses) ------
function earClip(poly) {
  const idx = poly.map((_, i) => i), tris = [];
  const area = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]);
  let guard = 0;
  while (idx.length > 3 && guard++ < 10000) {
    let cut = false;
    for (let i = 0; i < idx.length; i++) {
      const ia = idx[(i + idx.length - 1) % idx.length], ib = idx[i], ic = idx[(i + 1) % idx.length];
      const a = poly[ia], b = poly[ib], c = poly[ic];
      if (area(a, b, c) <= 1e-12) continue;
      if (idx.some((j) => j !== ia && j !== ib && j !== ic &&
          area(a, b, poly[j]) >= 0 && area(b, c, poly[j]) >= 0 && area(c, a, poly[j]) >= 0)) continue;
      tris.push([ia, ib, ic]); idx.splice(i, 1); cut = true; break;
    }
    if (!cut) break;
  }
  tris.push([idx[0], idx[1], idx[2]]);
  return tris;
}
/** Profile (y, z) extruded x0..x1: a closed, outward soup. */
function extrude(poly, x0, x1) {
  let A = 0;
  for (let i = 0; i < poly.length; i++) { const a = poly[i], b = poly[(i + 1) % poly.length]; A += a[0] * b[1] - b[0] * a[1]; }
  if (A < 0) poly = poly.slice().reverse();
  const out = [];
  for (const [a, b, c] of earClip(poly)) {
    out.push(x1, ...poly[a], x1, ...poly[b], x1, ...poly[c]);
    out.push(x0, ...poly[a], x0, ...poly[c], x0, ...poly[b]);
  }
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    out.push(x0, ...a, x1, ...b, x1, ...a, x0, ...a, x0, ...b, x1, ...b);
  }
  return Float32Array.from(out);
}
function box(lo, hi) {
  const v = [[lo[0], lo[1], lo[2]], [hi[0], lo[1], lo[2]], [hi[0], hi[1], lo[2]], [lo[0], hi[1], lo[2]],
             [lo[0], lo[1], hi[2]], [hi[0], lo[1], hi[2]], [hi[0], hi[1], hi[2]], [lo[0], hi[1], hi[2]]];
  const f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4],
             [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  const o = [];
  for (const t of f) for (const i of t) o.push(...v[i]);
  return new Float32Array(o);
}

// Crop stage 2's recorded result for the same relocation: the -Y lip moved to
// the mirror-opposite +Y side at its own height. From docs/CROP.md, "Stage 2",
// on branch claude/crop-stage2-move (commit 3b4227a), tools/nso_crop_move_test.js.
const STAGE2 = {
  span: 'X 74..86 (a 12 mm region; its box cannot reach the bar\'s ends)',
  branch: 'bridge', gapMm: 0.897, bridgeMm3: 6.22,
  bridgePitch: '0.08 .. 0.15 mm (surface nets on a closing of the two parts)',
  checker: 'PASS, self-intersection included'
};

(async function main() {
  const t0 = Date.now();
  const v9 = readSTL(path.join(ROOT, 'library', 'v9_mirror_factory.stl'));
  const det = F.detect(v9);
  const fl = det.flanges[0];

  // =========================================================================
  console.log('\n1. The audit: what detection gives, what one cut cannot do, what attach needed');
  const P = fl.cut.pieces;
  check('detection gives the root plane: normal -Y, the cut 2 um clear of the outermost wall',
    fl.cut.normal.join(',') === '0,-1,0' && Math.abs(fl.cut.offset - 2.01227) < 1e-4, f3(fl.cut.offset));
  check('...and now the wall as the pieces it is made of: 3 planes', P.length === 3,
    P.map((p) => p.offset.toFixed(4) + ' [' + p.lo.toFixed(3) + ', ' + p.hi.toFixed(3) + ']').join('  '));
  check('the three planes are -2.0103 / -1.9987 / -1.9897, each flat to the float',
    Math.abs(P[0].offset - 2.0103) < 1e-4 && Math.abs(P[1].offset - 1.9987) < 1e-4 &&
    Math.abs(P[2].offset - 1.9897) < 1e-4 && P.every((p) => p.spread < 1e-6));
  check('they step exactly at the two Mirror-Join seams, x = -88.565 and 87.537, meeting end to end',
    Math.abs(P[0].hi + 88.565) < 1e-3 && Math.abs(P[1].hi - 87.537) < 1e-3 && P[0].hi === P[1].lo && P[1].hi === P[2].lo);

  // One cut, on the flange's own plane: the hull keeps a skin of flange.
  const oneCut = rawCut(v9, 1, -fl.cut.offset, true);
  const skin = [0, 0, 0];
  for (let i = 0; i < oneCut.length; i += 3) {
    const x = oneCut[i], out = -oneCut[i + 1];
    const k = x < P[0].hi ? 0 : (x > P[1].hi ? 2 : 1);
    if (out - P[k].offset > skin[k]) skin[k] = out - P[k].offset;
  }
  const oneCutV = validate(oneCut, 'audit-one-cut');
  check('one cut on the flange\'s plane: a valid solid, but it keeps a skin of flange past the wall',
    oneCutV.verdict === 'PASS' && skin[1] > 0.013 && skin[2] > 0.022,
    'skin ' + skin.map(um).join(' / ') + ' (-X / between the seams / +X)');
  // One cut on the innermost piece: the neck below the flange is shaved.
  const inner = rawCut(v9, 1, -P[2].offset, true);
  let shaved = Infinity;
  for (let i = 0; i < inner.length; i += 3) if (inner[i] < P[0].hi - 0.5 && inner[i + 2] < 7) shaved = Math.min(shaved, P[0].offset + inner[i + 1]);
  // shaved = (wall piece offset) - (how far out the hull now reaches there)
  const innerOut = (() => { let m = -Infinity; for (let i = 0; i < inner.length; i += 3) if (inner[i] < P[0].hi - 0.5 && inner[i + 2] < 7) m = Math.max(m, -inner[i + 1]); return m; })();
  check('one cut on the innermost wall piece: the neck wall itself is cut back, below the flange',
    P[0].offset - innerOut > 0.02, 'the -X neck wall goes from ' + f3(P[0].offset) + ' to ' + f3(innerOut) +
    ' mm: ' + um(P[0].offset - innerOut) + ' of body shaved off, all the way down the wall');

  // Assemble, as it was: the foot, the twist, the length.
  const d0 = DT.detach(v9, fl);
  const piece0 = d0.piece;
  const fr = piece0.frame;
  const mirrorRoot = [fr.origin[0], -fr.origin[1], fr.origin[2]];
  const at0 = castTo(d0.hull, mirrorRoot, [0, -1, 0], 20);
  const plain = AS.attach(d0.hull, piece0.local, { at: at0, dir: [0, 1, 0] });
  const offAim = plain.dir ? Math.acos(Math.min(1, plain.dir[1])) * 180 / Math.PI : NaN;
  check('attach as it was aims a flange from the wrong foot: the body point nearest its TIP',
    plain.footDriftMm > 10 && offAim > 30,
    'foot ' + f3(plain.footDriftMm) + ' mm from the picked root, on the teeth the tip overhangs; aimed ' +
      offAim.toFixed(1) + ' deg off the asked direction' + (plain.ok ? ', seated ' + f3(plain.engageMm) + ' mm deep' : '') +
      '. Its drift gate is half the arm\'s width, ' + f3(AS.armWidth(piece0.local) / 2) + ' mm for a 187 mm plate');
  // place() turns local +Z onto the aim by the shortest turn; where the
  // plate's normal (local +Y) lands is whatever that turn makes of it.
  const turned = (dir) => {
    const pl = SA.place(piece0.local, [0, 0, 0], dir);
    const b = bounds(pl.soup);
    return [0, 1, 2].map((k) => b.hi[k] - b.lo[k]);
  };
  const toY = turned([0, 1, 0]), toX = turned([1, 0, 0]);
  // Aimed +Y: which way do the faces that were the flange's TOP (local +Y)
  // face once placed? place() keeps the triangle order.
  const upY = SA.place(piece0.local, [0, 0, 0], [0, 1, 0]).soup, L0 = piece0.local;
  const nrm = (s, o, k) => {
    const u = [s[o + 3] - s[o], s[o + 4] - s[o + 1], s[o + 5] - s[o + 2]], v = [s[o + 6] - s[o], s[o + 7] - s[o + 1], s[o + 8] - s[o + 2]];
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    return n[k] / Math.hypot(n[0], n[1], n[2]);
  };
  let tops = 0, flipped = 0;
  for (let o = 0; o < L0.length; o += 9) {
    if (!(nrm(L0, o, 1) > 0.99)) continue;
    tops++;
    if (nrm(upY, o, 2) < -0.99) flipped++;
  }
  check('without a twist, the shortest turn decides how the plate lies: to +X it stands on end, to +Y upside down',
    Math.abs(toX[2] - 186.987) < 0.01 && tops > 0 && flipped === tops,
    'to +X: ' + f3(toX[2]) + ' mm tall; to +Y: ' + f3(toY[2]) + ' tall, but ' + flipped + ' of the ' + tops +
      ' faces of its top now face down');
  const ext = ctx.NSO_extendRaw(piece0.local, { axis: 'z', length: piece0.reachMm + 0.9, gate: true });
  check('Extend will not lengthen the flange to cover the seat, in its own words',
    !ext.ok && /no constant cross-section band/.test(ext.reason), (ext.reason || '').slice(0, 110) + '...');
  const er = DT.extendRoot(piece0.local, { axis: 'z', length: piece0.reachMm + 0.9 });
  const erC = ctx.NSO_cropEdgeCensus(er.tris);
  check('its flat root can: extendRoot keeps it closed and adds exactly root area x growth',
    er.ok && !erC.open && !erC.repeated && !erC.degenerate &&
    Math.abs(volume(er.tris) - volume(piece0.local) - piece0.rootArea * 0.9) < 1e-3,
    er.reason + ', +' + f3(volume(er.tris) - volume(piece0.local)) + ' mm^3');

  // =========================================================================
  console.log('\n2. Detach on the clamp bar');
  const d = d0;
  check('detached', d.ok, d.reason);
  check('the hull is cut once per wall piece and sealed at both steps', d.seals.length === 2,
    d.seals.map((s) => 'x ' + f3(s.at) + ': ' + s.capLoops + ' step-face loop(s)').join(', '));
  const hv = validate(d.hull, 'v9-hull', true);
  check('the hull passes the canonical checker, self-intersection included', hv.clean, hv.summary);
  check('...one solid (chi 2)', hv.euler_characteristic === 2);
  check('no trace: nothing of the hull stands past its own wall piece', d.traceMm === 0, um(d.traceMm));
  // The root is capped flush: in the band, next to the wall, only cap on a
  // wall piece's plane or the seams' step faces.
  let capTris = 0, stepTris = 0;
  const strayTris = [];
  const capArea = [0, 0, 0];
  const b0 = fl.band[0], b1 = fl.band[1];
  for (let o = 0; o < d.hull.length; o += 9) {
    const ys = [d.hull[o + 1], d.hull[o + 4], d.hull[o + 7]], zs = [d.hull[o + 2], d.hull[o + 5], d.hull[o + 8]];
    const xs = [d.hull[o], d.hull[o + 3], d.hull[o + 6]];
    if (Math.max(...ys) > -1.98 || Math.min(...zs) < b0 - 1e-6) continue;
    const k = P.findIndex((p) => ys.every((y) => y === Math.fround(-p.offset)));
    if (k >= 0) { capTris++; capArea[k] += triArea(d.hull, o); continue; }
    if (xs.every((x) => x === xs[0]) && (xs[0] === P[0].hi || xs[0] === P[1].hi)) { stepTris++; continue; }
    strayTris.push(...d.hull.subarray(o, o + 9));
  }
  const strayOff = offSurface(Float32Array.from(strayTris), [v9], 2e-4);
  check('the root is capped on the wall itself: every face there is cap on a wall piece, a seam step, or the source\'s own',
    strayOff.off === 0 && capTris > 0 && stepTris > 0,
    capTris + ' cap, ' + stepTris + ' step, ' + strayOff.tris + ' of the source\'s own (the bar\'s rounded ends)');
  // Away from the root, the hull IS the source.
  const hk = new Set();
  for (let i = 0; i < d.hull.length; i += 3) hk.add(d.hull[i] + ',' + d.hull[i + 1] + ',' + d.hull[i + 2]);
  let far = 0, kept = 0;
  const seen = new Set();
  for (let i = 0; i < v9.length; i += 3) {
    const x = v9[i], y = v9[i + 1];
    if (y < -1.9 || Math.abs(x - P[0].hi) < 0.5 || Math.abs(x - P[1].hi) < 0.5) continue;
    const kk = x + ',' + y + ',' + v9[i + 2];
    if (seen.has(kk)) continue;
    seen.add(kk); far++;
    if (hk.has(kk)) kept++;
  }
  check('away from the root and the seams, every source vertex is in the hull bit for bit', kept === far,
    kept + ' of ' + far);
  const V = d.volumes;
  const sliverForm = P.reduce((s, p, k) => s + (fl.cut.offset - p.offset) * capArea[k], 0);
  check('volumes add up: source = hull + flange + the 2..22.6 um sliver between the flange\'s cut and the wall',
    Math.abs(V.sliver - sliverForm) < 0.01,
    f3(V.source) + ' = ' + f3(V.hull) + ' + ' + f3(V.piece) + ' + ' + f3(V.sliver) +
    ' (closed form from the cap areas: ' + f3(sliverForm) + ')');
  const ex = F.extract(v9, fl, rawCut);
  let same = ex.positions.length === d.piece.soup.length;
  for (let i = 0; same && i < ex.positions.length; i++) same = ex.positions[i] === d.piece.soup[i];
  check('the flange is the Flange tab\'s flange, bit for bit', same, (d.piece.soup.length / 9) + ' tris');
  const pv = validate(d.piece.local, 'v9-flange', true);
  check('the flange passes the canonical checker on its own, self-intersection included', pv.clean, pv.summary);
  check('its volume is the flange\'s: 8146.2 mm^3', Math.abs(V.piece - 8146.2) < 0.1, f3(V.piece));
  const lb = bounds(d.piece.local);
  check('in Assemble\'s frame: root on z = 0, reaching +Z 15 mm, plate thickness on Y',
    lb.lo[2] === 0 && Math.abs(lb.hi[2] - 14.998) < 1e-3 && Math.abs(lb.hi[1] - lb.lo[1] - fl.thickness) < 1e-5,
    'z 0..' + f3(lb.hi[2]) + ', y ' + f3(lb.hi[1] - lb.lo[1]) + ', root face ' + f3(d.piece.rootArea) + ' mm^2');
  const back = DT.toWorld(d.piece);
  let worstBack = 0;
  for (let i = 0; i < back.length; i++) worstBack = Math.max(worstBack, Math.abs(back[i] - d.piece.soup[i]));
  check('its frame takes it back to where it was', worstBack < 1e-5, um(worstBack));
  check('time', d.ms < 15000, d.ms + ' ms (' + (v9.length / 9) + ' triangles)');

  // =========================================================================
  console.log('\n3. Reattach on the clamp bar, at the mirror-opposite position');
  // The flange's root, mirrored through the bar's middle (y -> -y), is in the
  // air: at the flange's height the +Y side of the body is the ridge's
  // rounded shoulder, 1.86 mm further in. The root goes where a line from the
  // mirrored root back toward the body meets it.
  check('the mirrored root is in the air; the body is met ' + f3(mirrorRoot[1] - at0[1]) + ' mm further in',
    at0 && mirrorRoot[1] - at0[1] > 1, 'root centre ' + mirrorRoot.map(f3).join(', ') + ' -> ' + at0.map(f3).join(', '));
  const r = DT.reattach(d.hull, d.piece, { at: at0, dir: [0, 1, 0] });
  check('seated by Assemble\'s attach', r.ok, r.reason);
  check('the seat is measured: rim gap + one extrusion line',
    r.ok && Math.abs(r.engageMm - (r.rootGapMm + 0.42)) < 1e-9, r.ok ? f3(r.rootGapMm) + ' + 0.420 = ' + f3(r.engageMm) : '');
  check('the length is kept: exactly the flange\'s own reach stands proud',
    r.ok && r.keptLength && Math.abs(r.exposedLengthMm - d.piece.reachMm) < 1e-9, r.ok ? f3(r.exposedLengthMm) + ' mm' : '');
  const sb = r.ok ? bounds(r.soup) : null;
  check('it lies the way it lay: flat, at its own height, flush with the top like the original',
    r.ok && Math.abs(sb.lo[2] - b0) < 1e-5 && Math.abs(sb.hi[2] - b1) < 1e-5,
    r.ok ? 'Z ' + f3(sb.lo[2]) + '..' + f3(sb.hi[2]) + ', Y ' + f3(sb.lo[1]) + '..' + f3(sb.hi[1]) +
      ', X ' + f3(sb.lo[0]) + '..' + f3(sb.hi[0]) + ', turned ' + r.twistDeg + ' deg about its reach first' : '');
  const u = await CSG.NSO_unionSoups(d.hull, r.soup);
  check('the union is one part', u.ok && u.parts === 1, u.ok ? u.parts + ' part, ' + (u.soup.length / 9) + ' tris' : u.reason);
  const rawU = validate(u.soup, 'v9-union-raw', false);
  const fin = DT.finishUnion(u.soup);
  check('the finish (Crop stage 2\'s weld at Cut\'s radius) closes what the checker\'s weld would join',
    fin.ok, 'raw union: ' + rawU.summary + ' -> ' + fin.reason);
  const uv = validate(fin.soup, 'v9-reattached', true);
  check('the result passes the canonical checker, self-intersection included', uv.clean, uv.summary);
  const uc = DT.unionCheck(d.hull, r.soup, fin.soup, r, d.piece);
  check('the flange meets the body at its seat only', uc.ok, uc.reason);
  const os = offSurface(fin.soup, [d.hull, r.soup], 2e-4);
  check('no bridging: every triangle of the result lies on the hull or on the flange',
    os.off === 0, os.off + ' of ' + os.tris + ' off both surfaces (worst ' + um(os.worst) + ')');
  // What it clears: the tooth tops under the plate.
  let teeth = -Infinity;
  for (let i = 0; i < d.hull.length; i += 3) if (d.hull[i + 1] > 1.5 && d.hull[i + 1] < sb.hi[1]) teeth = Math.max(teeth, d.hull[i + 2]);
  check('it cantilevers over the teeth, as the original cantilevered over air', teeth < b0,
    f3(b0 - teeth) + ' mm clear of the tooth tops (Z ' + f3(teeth) + ')');
  // Stage 2 split its result through the +seam ring, the landing and a slot wall.
  let splits = 0;
  for (const x of [87.53694152832031, 80, 77.3]) {
    const a = rawCut(fin.soup, 0, x, false), b2 = rawCut(fin.soup, 0, x, true);
    if (a && b2 && validate(a).verdict === 'PASS' && validate(b2).verdict === 'PASS') splits++;
  }
  check('split through the +seam ring, x 80 and a slot wall: both halves pass each time', splits === 3, splits + ' of 3');
  const cmp = [
    ['', 'Crop stage 2 (recorded)', 'Detach + Reattach'],
    ['what moves', STAGE2.span, 'the whole flange, X ' + f3(sb.lo[0]) + '..' + f3(sb.hi[0]) + ', across both seams'],
    ['how it meets the +Y side', STAGE2.branch + ', a ' + STAGE2.gapMm + ' mm gap', 'seated at its root, ' + f3(r.engageMm) + ' mm'],
    ['bridge material', '+' + STAGE2.bridgeMm3 + ' mm^3, sampled at ' + STAGE2.bridgePitch, '0 mm^3: ' + os.off + ' triangles off the input surfaces'],
    ['canonical checker', STAGE2.checker, uv.clean ? 'PASS, self-intersection included' : uv.summary],
    ['where it left', 'a notch, closed by the subtraction', 'the wall, capped flush, 0 um proud']
  ];
  console.log('\n     ' + cmp.map((row) => row.map((c, i) => (c + '').padEnd(i ? 44 : 26)).join('')).join('\n     ') + '\n');
  check('equal or better than Crop stage 2 for the same relocation: a clean solid with nothing bridged',
    uv.clean && os.off === 0 && uc.ok);

  // =========================================================================
  console.log('\n4. The part turned');
  for (const [label, soup] of [['turned 90 deg about Z', rot(v9, 'z', 90)], ['turned 30 deg about Z', rot(v9, 'z', 30)]]) {
    const dd = F.detect(soup);
    const dr = dd.flanges.length ? DT.detach(soup, dd.flanges[0]) : { ok: false, reason: 'no flange' };
    const hh = dr.ok ? validate(dr.hull) : null;
    check(label + ': detached, the hull passes, nothing past the wall',
      dr.ok && hh.verdict === 'PASS' && dr.traceMm <= 1e-5,
      dr.ok ? hh.summary + ', ' + dr.wall.pieces.length + ' wall pieces, trace ' + um(dr.traceMm) +
        ', flange ' + f3(dr.volumes.piece) + ' mm^3, ' + dr.ms + ' ms' : dr.reason);
    check('  ...the flange is the same flange', dr.ok && Math.abs(dr.volumes.piece - V.piece) / V.piece < 5e-4);
  }

  // =========================================================================
  console.log('\n5. Synthetic shapes');
  {
    // A 2 mm lip standing 10 mm off the -Y face of a 20 x 20 block, 40 long.
    const lip = extrude([[0, 0], [20, 0], [20, 20], [0, 20], [0, 18], [-10, 18], [-10, 16], [0, 16]], 0, 40);
    const ld = F.detect(lip);
    const dl = ld.flanges.length ? DT.detach(lip, ld.flanges[0]) : { ok: false, reason: 'no flange' };
    const lh = dl.ok ? validate(dl.hull, 'lip-hull', true) : null;
    check('lip on a block: one flat wall piece, one cut, no seal', dl.ok && dl.wall.pieces.length === 1 && !dl.seals.length,
      dl.ok ? '' : dl.reason);
    check('  ...the hull is the block, exactly: 16000 mm^3, 20 x 20 x 40', dl.ok && lh.clean &&
      Math.abs(dl.volumes.hull - 16000) < 1e-3 && bounds(dl.hull).lo[1] === 0, dl.ok ? lh.summary + ', ' + f3(dl.volumes.hull) : '');
    check('  ...and the lip is the lip, less its 2 um root clearance', dl.ok && Math.abs(dl.volumes.piece - 800) < 0.2,
      dl.ok ? f3(dl.volumes.piece) : '');
    // Put it on the +Y face instead.
    const at = [20, 20, 17];
    const lr = dl.ok ? DT.reattach(dl.hull, dl.piece, { at, dir: [0, 1, 0] }) : { ok: false };
    const lu = lr.ok ? await CSG.NSO_unionSoups(dl.hull, lr.soup) : null;
    const lf = lu && lu.ok ? DT.finishUnion(lu.soup) : null;
    const lv = lf && lf.ok ? validate(lf.soup, 'lip-reattached', true) : null;
    const lc = lv ? DT.unionCheck(dl.hull, lr.soup, lf.soup, lr, dl.piece) : null;
    const lb2 = lf ? bounds(lf.soup) : null;
    check('  ...reattached on the opposite face: one solid, PASS, seated only, its full reach proud',
      lv && lv.clean && lu.parts === 1 && lc.ok && Math.abs(lb2.hi[1] - (20 + dl.piece.reachMm)) < 1e-4,
      lv ? lv.summary + ', ' + lc.reason + ', reaches y ' + f3(lb2.hi[1]) : (lr.reason || 'union failed'));
    check('  ...the rim gap on a flat face is 0, so the seat is exactly one extrusion line',
      lr.ok && lr.rootGapMm < 1e-9 && Math.abs(lr.engageMm - 0.42) < 1e-12, lr.ok ? f3(lr.engageMm) : '');
  }
  {
    // T section: 2 mm wings on a 4 mm web (tools/nso_flange_test.js's). Both wings are flanges.
    const T = extrude([[-15, 8], [-2, 8], [-2, -10], [2, -10], [2, 8], [15, 8], [15, 10], [-15, 10]], -40, 40);
    const td = F.detect(T);
    const dt = td.flanges.length ? DT.detach(T, td.flanges[0]) : { ok: false, reason: 'no flange' };
    const tv = dt.ok ? validate(dt.hull, 'tee-hull', true) : null;
    const tWant = (4 * 18 + 30 * 2 - 13 * 2) * 80;
    check('T section: one wing off, the hull is the web and the other wing, exactly, PASS',
      td.flanges.length === 2 && dt.ok && tv.clean && Math.abs(dt.volumes.hull - tWant) < 1e-3,
      dt.ok ? tv.summary + ', ' + f3(dt.volumes.hull) + ' of ' + tWant : dt.reason);
    // What is left is a leg on a 4 mm web: an L, which the rule does not call
    // a flange. The wing that stays carried on across the web into the one
    // that went; it no longer does.
    const td2 = dt.ok ? F.detect(dt.hull) : { flanges: [], candidates: [] };
    const wing = td2.candidates.find((c) => Math.abs(c.thickness - 2) < 0.01 && c.failed.length === 1);
    check('  ...the wing that stays now reads as a leg off a web, not a flange (fails "body")',
      td2.flanges.length === 0 && wing && wing.failed[0] === 'body', F.describe(td2));
  }
  {
    // Hat section: 2 mm brims (tools/nso_flange_test.js's).
    const H = extrude([[-25, 0], [-10, 0], [-10, 15], [10, 15], [10, 0], [25, 0], [25, 2], [12, 2], [12, 17],
                       [-12, 17], [-12, 2], [-25, 2]], -30, 30);
    const hd = F.detect(H);
    const dh = hd.flanges.length ? DT.detach(H, hd.flanges[0]) : { ok: false, reason: 'no flange' };
    const hvv = dh.ok ? validate(dh.hull, 'hat-hull', true) : null;
    check('hat section: one brim off, the hull passes and is the hat less that brim, exactly',
      hd.flanges.length === 2 && dh.ok && hvv.clean && Math.abs(dh.volumes.source - dh.volumes.hull - 13 * 2 * 60) < 1e-3,
      dh.ok ? hvv.summary + ', ' + f3(dh.volumes.source - dh.volumes.hull) + ' of ' + 13 * 2 * 60 + ' mm^3 off' : dh.reason);
  }

  // =========================================================================
  console.log('\n6. Refusals, each by name, and nothing made');
  {
    const a = DT.detach(v9, null);
    check('not a detected flange', !a.ok && /not a detected flange/.test(a.reason), a.reason);
    const bad = JSON.parse(JSON.stringify(fl));
    bad.cut.pieces[1].lo += 3;
    const b = DT.detach(v9, bad);
    check('wall pieces that do not meet end to end along the root', !b.ok && /do not meet end to end/.test(b.reason), b.reason);
    // A lip, and a boss on the same face that is not part of it. The root
    // plane cuts both; the hull would lose the boss.
    const lip = extrude([[0, 0], [20, 0], [20, 20], [0, 20], [0, 18], [-10, 18], [-10, 16], [0, 16]], 0, 40);
    const withBoss = await CSG.NSO_unionSoups(lip, box([15, -3, 2], [25, 0.5, 6]));
    const bd = F.detect(withBoss.soup);
    const c = bd.flanges.length ? DT.detach(withBoss.soup, bd.flanges[0]) : { ok: false, reason: 'no flange found' };
    check('the root plane takes body that is not the flange (a boss on the same face)',
      !c.ok && /does not add up|do not add up|not the flange/.test(c.reason), c.reason);
    const e = DT.reattach(d.hull, null, { at: at0, dir: [0, 1, 0] });
    check('reattach with nothing detached', !e.ok && /nothing detached/.test(e.reason), e.reason);
    // The root put on the -Y neck wall, aimed INTO the body.
    const into = DT.reattach(d.hull, d.piece, { at: [0, -1.9987421035766602, 0], dir: [0, 1, 0] });
    check('a line out of the picked point that runs into the body', !into.ok && /blocked/.test(into.reason), into.reason);
    // The same mirror-opposite, 2 mm lower: the plate runs into the teeth.
    const low = castTo(d.hull, [mirrorRoot[0], mirrorRoot[1], mirrorRoot[2] - 2], [0, -1, 0], 20);
    const lr = DT.reattach(d.hull, d.piece, { at: low, dir: [0, 1, 0] });
    const lu = lr.ok ? await CSG.NSO_unionSoups(d.hull, lr.soup) : null;
    const lf = lu && lu.ok ? DT.finishUnion(lu.soup) : null;
    const lc = lf ? DT.unionCheck(d.hull, lr.soup, lf.soup, lr, d.piece) : { ok: true, reason: lr.reason };
    check('2 mm lower, into the teeth: refused - Reattach puts a piece back, it does not trim one',
      !lc.ok && /runs into the body past its seat/.test(lc.reason), lc.reason);
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed  (' + ((Date.now() - t0) / 1000).toFixed(1) + ' s)');
  if (fail) { console.log('FAILED: ' + FAILS.join(' | ')); process.exit(1); }
  process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
