#!/usr/bin/env node
// Headless self-test for nso_thread_extend.js (Fasteners > Extend: a screw's thread made longer or shorter by whole pitches, its pitch,
// size and profile kept). docs/THREADS.md, "Extend a screw's thread".
//
//   node tools/nso_thread_extend_test.js        exit 0 = every gate held
//
// The screws are nso_thread.js's own (so the pitch, the hand and the sizes are known exactly), laid in different poses. Everything is
// measured on the OUTPUT: an exact-bit edge counter (closed, 2-manifold, consistently wound, Euler 2), tools/mesh_validate.py --gate
// (which welds at 1e-4 and looks for self-intersections), the length along the axis, the volume against the original's per-pitch volume,
// rising flanks a pitch apart ALL the way along the new thread (across every seam), and the head's vertices untouched.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const vm = require('vm');
for (const f of ['nso_thickness.js', 'nso_thread.js']) vm.runInThisContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), { filename: f });
const T = globalThis.NSO_Thread, X = require('../nso_thread_extend.js');
const { writeSTL } = require('./nso_stl_io.js');

let pass = 0, fail = 0;
const FAILS = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok    ' + name + (detail ? '   ' + detail : '')); }
  else { fail++; FAILS.push(name); console.log('  FAIL  ' + name + (detail ? '   ' + detail : '')); }
}
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nso-thread-ext-'));
const f3 = x => (+x).toFixed(3);
const near = (a, b, t) => Math.abs(a - b) <= t;

function topo(s) {
  const key = i => s[i] + ',' + s[i + 1] + ',' + s[i + 2], ids = new Map(), vid = [];
  for (let i = 0; i < s.length; i += 3) { const k = key(i); if (!ids.has(k)) ids.set(k, ids.size); vid.push(ids.get(k)); }
  const E = new Map(); let degen = 0;
  for (let t = 0; t < vid.length / 3; t++) {
    const a = vid[t * 3], b = vid[t * 3 + 1], c = vid[t * 3 + 2];
    if (a === b || b === c || a === c) degen++;
    for (const [p, q] of [[a, b], [b, c], [c, a]]) { const k = Math.min(p, q) + ':' + Math.max(p, q), e = E.get(k) || { n: 0, f: 0 }; e.n++; if (p < q) e.f++; E.set(k, e); }
  }
  let open = 0, nm = 0, flip = 0; E.forEach(e => { if (e.n === 1) open++; else if (e.n > 2) nm++; else if (e.f !== 1) flip++; });
  return { tris: vid.length / 3, open, nm, flip, degen, euler: ids.size - E.size + vid.length / 3 };
}
function volume(s) { let v = 0; for (let o = 0; o < s.length; o += 9) v += s[o] * (s[o + 4] * s[o + 8] - s[o + 5] * s[o + 7]) - s[o + 1] * (s[o + 3] * s[o + 8] - s[o + 5] * s[o + 6]) + s[o + 2] * (s[o + 3] * s[o + 7] - s[o + 4] * s[o + 6]); return v / 6; }
function meshValidate(name, soup) {
  const file = path.join(TMP, name + '.stl'); writeSTL(file, soup);
  let out; try { out = execFileSync('python3', [path.join(ROOT, 'tools', 'mesh_validate.py'), file, '--json', '--gate'], { encoding: 'utf8', maxBuffer: 64 << 20 }); } catch (e) { out = e.stdout; }
  try { const j = JSON.parse(out); return { pass: j.verdict === 'PASS', fails: j.verdict_fails || [] }; } catch (e) { return { pass: false, fails: ['no JSON'] }; }
}
// the soup moved by a rotation R (row-major 3x3) and a translation
function pose(s, R, t) { const o = new Float32Array(s.length); for (let i = 0; i < s.length; i += 3) { const x = s[i], y = s[i + 1], z = s[i + 2]; for (let k = 0; k < 3; k++) o[i + k] = R[3 * k] * x + R[3 * k + 1] * y + R[3 * k + 2] * z + t[k]; } return o; }
const rotY = a => [Math.cos(a), 0, Math.sin(a), 0, 1, 0, -Math.sin(a), 0, Math.cos(a)];
const rotX = a => [1, 0, 0, 0, Math.cos(a), -Math.sin(a), 0, Math.sin(a), Math.cos(a)];
const mul = (A, B) => { const o = []; for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) o.push(A[3 * r] * B[c] + A[3 * r + 1] * B[3 + c] + A[3 * r + 2] * B[6 + c]); return o; };
// the extent along a unit direction
function span(s, u) { let lo = Infinity, hi = -Infinity; for (let i = 0; i < s.length; i += 3) { const d = s[i] * u[0] + s[i + 1] * u[1] + s[i + 2] * u[2]; lo = Math.min(lo, d); hi = Math.max(hi, d); } return { lo, hi, len: hi - lo }; }
// the outer radius along the axis (frame of rd) at angle 0: rising crossings of the mid radius, as heights
function rises(s, rd, from, to) {
  const c = rd.axis.c, u = rd.axis.u, v = rd.axis.v, mid = (rd.majorDia + rd.minorDia) / 4, dz = 0.01, out = [];
  // rays from outside toward the axis along -v at heights z: the first hit is the outer surface
  function r(z) {
    const o = [c[0] + u[0] * z + v[0] * 100, c[1] + u[1] * z + v[1] * 100, c[2] + u[2] * z + v[2] * 100], d = [-v[0], -v[1], -v[2]]; let best = Infinity;
    for (let t = 0; t < s.length; t += 9) {
      const e1 = [s[t + 3] - s[t], s[t + 4] - s[t + 1], s[t + 5] - s[t + 2]], e2 = [s[t + 6] - s[t], s[t + 7] - s[t + 1], s[t + 8] - s[t + 2]];
      const p = [d[1] * e2[2] - d[2] * e2[1], d[2] * e2[0] - d[0] * e2[2], d[0] * e2[1] - d[1] * e2[0]], det = e1[0] * p[0] + e1[1] * p[1] + e1[2] * p[2];
      if (Math.abs(det) < 1e-12) continue;
      const tv = [o[0] - s[t], o[1] - s[t + 1], o[2] - s[t + 2]], uu = (tv[0] * p[0] + tv[1] * p[1] + tv[2] * p[2]) / det; if (uu < 0 || uu > 1) continue;
      const q = [tv[1] * e1[2] - tv[2] * e1[1], tv[2] * e1[0] - tv[0] * e1[2], tv[0] * e1[1] - tv[1] * e1[0]], vv = (d[0] * q[0] + d[1] * q[1] + d[2] * q[2]) / det; if (vv < 0 || uu + vv > 1) continue;
      const tt = (e2[0] * q[0] + e2[1] * q[1] + e2[2] * q[2]) / det; if (tt > 0 && tt < best) best = tt;
    }
    return 100 - best;
  }
  // only the triangles near the line: cut the soup to a slab round it first (speed)
  let prev = r(from);
  for (let z = from + dz; z <= to; z += dz) { const rr = r(z); if (prev < mid && rr >= mid) out.push(z - dz * (rr - mid) / (rr - prev)); prev = rr; }
  return out;
}
function nearLine(s, rd) {     // the triangles within 1.5 x the thread's radius of the axis line, on the +v side: enough for rises()
  const c = rd.axis.c, v = rd.axis.v, keep = [];
  for (let t = 0; t < s.length; t += 9) { let ok = false; for (let k = 0; k < 3; k++) { const d = (s[t + 3 * k] - c[0]) * v[0] + (s[t + 3 * k + 1] - c[1]) * v[1] + (s[t + 3 * k + 2] - c[2]) * v[2]; if (d > 0) ok = true; } if (ok) for (let k = 0; k < 9; k++) keep.push(s[t + k]); }
  return new Float32Array(keep);
}

const CASES = [
  { name: 'knurled thumb screw M12 (24 mm plain shank, flat end)', make: () => T.bolt({ size: 'M12', head: 'knurled', length: 40, shank: 14 }), pose: [[1, 0, 0, 0, 1, 0, 0, 0, 1], [0, 0, 0]], spec: 'M12', tip: 1 },
  { name: 'fluted thumb screw M10, bevelled tip', make: () => T.bolt({ size: 'M10', head: 'fluted', length: 22, bevel: T.bevelDefault('M10') }), pose: [[1, 0, 0, 0, 1, 0, 0, 0, 1], [5, -3, 0]], spec: 'M10', tip: 1 },
  { name: 'hex bolt M8 lying along -X (head at +X)', make: () => T.bolt({ size: 'M8', length: 30 }), pose: [rotY(-Math.PI / 2), [40, 10, 6]], spec: 'M8', tip: -1 },
  { name: 'left-hand hex bolt M10 tilted 20° (an axis that is no world axis)', make: () => T.bolt({ size: 'M10', length: 26, hand: 'left' }), pose: [mul(rotX(0.35), rotY(0.2)), [0, 0, 8]], spec: 'M10', tip: 1, left: true }
];

for (const C of CASES) {
  console.log('\n=== ' + C.name + ' ===');
  const made = C.make(), sp = made.info.spec, s0 = pose(made.soup, C.pose[0], C.pose[1]);
  const t0 = Date.now(), rd = X.read(s0), msR = Date.now() - t0;
  console.log('   ' + (rd.ok ? rd.reason : 'REFUSED ' + rd.reason) + '   (' + msR + ' ms)');
  check('read: made a reading', rd.ok, rd.reason);
  if (!rd.ok) continue;
  check('the pitch is the screw\'s: ' + f3(rd.pitch) + ' = ' + f3(sp.P) + (rd.pitchSnapped ? ' (snapped to a whole 0.05 / TPI)' : ' (measured)'), near(rd.pitch, sp.P, 2e-3));
  check('the hand is the screw\'s (' + (C.left ? 'left' : 'right') + ')', rd.hand === (C.left ? -1 : 1) && rd.handClear);
  check('the thread\'s Ø: crests Ø' + f3(rd.majorDia) + ' (' + sp.major + '), roots Ø' + f3(rd.minorDia) + ' (' + f3(sp.minor) + ')', near(rd.majorDia, sp.major, 0.03) && near(rd.minorDia, sp.minor, 0.03));
  const along = [rd.axis.u[0] * rd.tip, rd.axis.u[1] * rd.tip, rd.axis.u[2] * rd.tip];
  const want = pose([[0, 0, 1]].flat(), C.pose[0], [0, 0, 0]);
  check('the tip is the free end (the head stays): the tip direction is the screw\'s +z as posed', near(along[0] * want[0] + along[1] * want[1] + along[2] * want[2], 1, 1e-3), along.map(f3).join(','));
  const sp0 = span(s0, along), v0 = volume(s0);
  let perPitch = null;
  for (const turns of [1, 4, 11, -2]) {
    const t1 = Date.now(), r = X.extend(s0, rd, turns), ms = Date.now() - t1;
    check('extend ' + (turns > 0 ? '+' : '') + turns + ': made (' + ms + ' ms)', r.ok, r.reason);
    if (!r.ok) continue;
    const tp = topo(r.soup);
    check('  closed, 2-manifold, consistently wound, no zero-area faces, Euler 2', tp.open === 0 && tp.nm === 0 && tp.flip === 0 && tp.degen === 0 && tp.euler === 2, JSON.stringify(tp));
    if (Math.abs(turns) !== 4) { const MV = meshValidate(C.name.slice(0, 12).replace(/\W+/g, '_') + '_' + turns, r.soup); check('  mesh_validate --gate (welds at 1e-4, self-intersections)', MV.pass, MV.fails.join('; ')); }
    const sp1 = span(r.soup, along);
    check('  ' + f3(sp1.len - sp0.len) + ' mm longer along the axis (' + turns + ' x ' + f3(rd.pitch) + '), the head end where it was', near(sp1.len - sp0.len, turns * rd.pitch, 2e-3) && near(sp1.lo, sp0.lo, 1e-4));
    const dv = volume(r.soup) - v0;
    if (perPitch === null && turns === 1) perPitch = dv;
    else if (perPitch !== null) check('  the volume changes by ' + turns + ' pitches\' worth (' + f3(dv) + ' vs ' + f3(turns * perPitch) + ' mm³)', near(dv, turns * perPitch, Math.abs(turns * perPitch) * 0.004 + 0.05));
    if (turns === 11) {
      // the thread runs on, a pitch per turn, through every seam: rising flanks along the whole new thread
      const lineSoup = nearLine(r.soup, rd);
      const zLo = rd.tip > 0 ? rd.full.lo : -rd.full.hi, zs = rises(lineSoup, Object.assign({}, rd, { axis: Object.assign({}, rd.axis, { u: along }) }), Math.min(rd.full.lo, rd.full.hi) * 0 + (rd.tip > 0 ? rd.full.lo : -rd.full.hi), (rd.tip > 0 ? rd.full.hi : -rd.full.lo) + 11 * rd.pitch);
      let worst = 0; for (let i = 1; i < zs.length; i++) worst = Math.max(worst, Math.abs(zs[i] - zs[i - 1] - rd.pitch));
      check('  along the lengthened thread, ' + zs.length + ' rising flanks a pitch apart through every seam (worst ' + f3(worst) + ' mm off)', zs.length >= 15 && worst < 0.02, f3(worst));
    }
  }
}

console.log('\n=== refusals ===');
{
  const no = (tag, r, re) => { console.log('   ' + r.reason); check('refused: ' + tag, !r.ok && !r.soup && re.test(r.reason), r.reason); };
  no('a box (not turned about an axis)', X.read(pose(T.bolt({ size: 'M8', length: 20 }).soup.slice(0, 0).length ? null : (function () { const v = [[0, 0, 0], [30, 0, 0], [30, 12, 0], [0, 12, 0], [0, 0, 6], [30, 0, 6], [30, 12, 6], [0, 12, 6]], f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]], o = []; f.forEach(t => t.forEach(i => o.push(...v[i]))); return new Float32Array(o); })(), [1, 0, 0, 0, 1, 0, 0, 0, 1], [0, 0, 0])), /^the piece is not turned about an axis/);
  const S = require('../nso_stock.js');
  no('a plain cylinder (no thread)', X.read(S.revolve(S.profileTube ? [{ z: 0, r: 0 }, { z: 0, r: 5 }, { z: 30, r: 5 }, { z: 30, r: 0 }] : [], 64)), /^no thread found along the piece's axis/);
  no('a thread of two turns', X.read(T.bolt({ size: 'M8', length: 2.6 }).soup), /full turns - at least 3 are needed|^no thread found/);
  const b = T.bolt({ size: 'M8', length: 12 }).soup, rd = X.read(b);
  no('taking out more turns than the thread has', X.extend(b, rd, -40), /^the thread has .* full turns - at most \d+ can be taken out of it/);
  no('0 turns', X.extend(b, rd, 0), /^no change - 0 turns$/);
}

console.log('\n' + (fail ? fail + ' FAILED: ' + FAILS.join('; ') : 'all ' + pass + ' checks passed'));
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* tmp */ }
process.exit(fail ? 1 : 0);
