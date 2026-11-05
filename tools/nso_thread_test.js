#!/usr/bin/env node
// Headless self-test for nso_thread.js (Threads: rods, bolts, nuts, pipe/fitting ends, the tapped-hole cutter).
//
//   node tools/nso_thread_test.js        exit 0 = every gate held
//
// Every number is measured on the OUTPUT soup by code that shares nothing with the construction:
//   - the profile (major / minor Ø, crest and root flats, pitch, hand, taper) by casting rays from the axis
//     outward through the mesh at heights and angles the construction did not choose;
//   - topology by an exact-bit weld and edge counter (closed, 2-manifold, consistently wound, no zero-area
//     faces, Euler 2 for a solid and 0 for a ring), and tools/mesh_validate.py --gate (which welds at 1e-4);
//   - the volume against the closed form: a helical thread's cross-section has the SAME area at every height
//     (it only turns), so V = length x (pi / P) x integral of r(s)^2 ds, times the polygon's area factor;
//   - that a bolt turns in a nut: the nut's bore less the bolt's radius, at points all round, is the fit.

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const { writeSTL } = require('./nso_stl_io.js');
for (const f of ['nso_thickness.js', 'nso_thread.js']) vm.runInThisContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), { filename: f });
const T = globalThis.NSO_Thread;

let pass = 0, fail = 0;
const FAILS = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok    ' + name + (detail ? '   ' + detail : '')); }
  else { fail++; FAILS.push(name); console.log('  FAIL  ' + name + (detail ? '   ' + detail : '')); }
}
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nso-thread-'));
const f3 = x => (+x).toFixed(3);
const near = (a, b, t) => Math.abs(a - b) <= t;

/* ------------------------------------------------------------- measuring */
function topo(s) {
  const key = i => s[i] + ',' + s[i + 1] + ',' + s[i + 2];
  const ids = new Map(), vid = [];
  for (let i = 0; i < s.length; i += 3) { const k = key(i); if (!ids.has(k)) ids.set(k, ids.size); vid.push(ids.get(k)); }
  const E = new Map();
  let degen = 0;
  for (let t = 0; t < vid.length / 3; t++) {
    const a = vid[t * 3], b = vid[t * 3 + 1], c = vid[t * 3 + 2];
    if (a === b || b === c || a === c) degen++;
    for (const [p, q] of [[a, b], [b, c], [c, a]]) {
      const k = Math.min(p, q) + ':' + Math.max(p, q), e = E.get(k) || { n: 0, f: 0 };
      e.n++; if (p < q) e.f++; E.set(k, e);
    }
  }
  let open = 0, nm = 0, flip = 0;
  E.forEach(e => { if (e.n === 1) open++; else if (e.n > 2) nm++; else if (e.f !== 1) flip++; });
  return { tris: vid.length / 3, verts: ids.size, open, nm, flip, degen, euler: ids.size - E.size + vid.length / 3 };
}
function volume(s) {
  let v = 0;
  for (let o = 0; o < s.length; o += 9) {
    v += s[o] * (s[o + 4] * s[o + 8] - s[o + 5] * s[o + 7]) - s[o + 1] * (s[o + 3] * s[o + 8] - s[o + 5] * s[o + 6]) +
         s[o + 2] * (s[o + 3] * s[o + 7] - s[o + 4] * s[o + 6]);
  }
  return v / 6;
}
function rayHits(s, o, d) {
  const hits = [];
  for (let t = 0; t < s.length; t += 9) {
    const e1 = [s[t + 3] - s[t], s[t + 4] - s[t + 1], s[t + 5] - s[t + 2]], e2 = [s[t + 6] - s[t], s[t + 7] - s[t + 1], s[t + 8] - s[t + 2]];
    const p = [d[1] * e2[2] - d[2] * e2[1], d[2] * e2[0] - d[0] * e2[2], d[0] * e2[1] - d[1] * e2[0]];
    const det = e1[0] * p[0] + e1[1] * p[1] + e1[2] * p[2];
    if (Math.abs(det) < 1e-12) continue;
    const tv = [o[0] - s[t], o[1] - s[t + 1], o[2] - s[t + 2]], u = (tv[0] * p[0] + tv[1] * p[1] + tv[2] * p[2]) / det;
    if (u < -1e-9 || u > 1 + 1e-9) continue;
    const q = [tv[1] * e1[2] - tv[2] * e1[1], tv[2] * e1[0] - tv[0] * e1[2], tv[0] * e1[1] - tv[1] * e1[0]];
    const v = (d[0] * q[0] + d[1] * q[1] + d[2] * q[2]) / det;
    if (v < -1e-9 || u + v > 1 + 1e-9) continue;
    const dist = (e2[0] * q[0] + e2[1] * q[1] + e2[2] * q[2]) / det;
    if (dist > 1e-9) hits.push(dist);
  }
  hits.sort((a, b) => a - b);
  return hits.filter((h, i) => i === 0 || h - hits[i - 1] > 1e-6);
}
function bbox(s, zlo, zhi) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < s.length; i += 3) {
    if (zlo != null && (s[i + 2] < zlo - 1e-9 || s[i + 2] > zhi + 1e-9)) continue;
    for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], s[i + k]); hi[k] = Math.max(hi[k], s[i + k]); }
  }
  return { lo, hi };
}
// the first surface met going out from the axis at height z, angle th (rad): its radius
function radius(s, th, z) { const h = rayHits(s, [0, 0, z], [Math.cos(th), Math.sin(th), 0]); return h.length ? h[0] : null; }
// all radii a ray out from the axis crosses at (th, z), nearest first
function radii(s, th, z) { return rayHits(s, [0, 0, z], [Math.cos(th), Math.sin(th), 0]); }
function meshValidate(name, soup) {
  const file = path.join(TMP, name + '.stl');
  writeSTL(file, soup);
  let out;
  try { out = execFileSync('python3', [path.join(ROOT, 'tools', 'mesh_validate.py'), file, '--json', '--gate'], { encoding: 'utf8', maxBuffer: 64 << 20 }); }
  catch (e) { out = e.stdout; }
  try { const j = JSON.parse(out); return { pass: j.verdict === 'PASS', fails: j.verdict_fails || [], pierce: j.self_intersection ? j.self_intersection.pierce : null }; }
  catch (e) { return { pass: false, fails: ['no JSON from mesh_validate: ' + String(out).slice(0, 80)] }; }
}
function closed(tag, soup, euler, noValidate) {
  const T0 = topo(soup);
  check(tag + ': closed, 2-manifold, consistently wound, no zero-area faces, Euler ' + euler,
    T0.open === 0 && T0.nm === 0 && T0.flip === 0 && T0.degen === 0 && T0.euler === euler, `${T0.tris} tris, open ${T0.open} nm ${T0.nm} flip ${T0.flip} degen ${T0.degen} euler ${T0.euler}`);
  if (!noValidate) {
    const MV = meshValidate(tag.replace(/[^a-z0-9]+/gi, '_'), soup);
    check(tag + ': mesh_validate --gate PASS (welds at 1e-4)', MV.pass, MV.pass ? 'pierce ' + MV.pierce : (MV.fails || []).join('; '));
  }
  check(tag + ': wound outward (volume > 0)', volume(soup) > 0, f3(volume(soup)) + ' mm³');
  return T0;
}
// the profile r(z) at angle th over [z, z + P): { min, max, rise, fall } with the z of the mid-radius crossings
function profileAt(s, th, z0, P, steps) {
  const pts = [];
  for (let i = 0; i <= steps; i++) { const z = z0 + P * i / steps; pts.push([z, radius(s, th, z)]); }
  return pts;
}
function crossings(pts, level) {
  const up = [], dn = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    const [za, ra] = pts[i], [zb, rb] = pts[i + 1];
    if (ra < level && rb >= level) up.push(za + (zb - za) * (level - ra) / (rb - ra));
    if (ra >= level && rb < level) dn.push(za + (zb - za) * (ra - level) / (ra - rb) * -1 + (zb - za) * 0 + (zb - za) * (ra - level) / (ra - rb) + za - za);
  }
  return { up, dn };
}
// a thread's analytic volume per unit length: (pi / P) x the integral of r^2 over a pitch, times the N-gon's area factor
function analyticPerLength(sp, N, off) {
  const R = sp.R + (off || 0), rm = R - sp.h, rr = [[0, sp.fr, rm, rm], [sp.fr, sp.fr + sp.w, rm, R], [sp.fr + sp.w, sp.fr + sp.w + sp.fc, R, R], [sp.fr + sp.w + sp.fc, sp.P, R, rm]];
  let I = 0;
  for (const [a, b, ra, rb] of rr) I += (b - a) * (ra * ra + ra * rb + rb * rb) / 3;
  return Math.PI * I / sp.P * (N * Math.sin(2 * Math.PI / N) / (2 * Math.PI));
}
const TABLE = [];

(async () => {
  /* ===================================================================== SPEC */
  console.log('\n=== 1. the thread as numbers ===');
  {
    const m8 = T.spec('M8').spec;
    check('M8: Ø8, pitch 1.25, ISO 60° - depth 0.6134 P = ' + f3(m8.h) + ', crest P/8 = ' + f3(m8.fc) + ', root flat P/6 = ' + f3(m8.fr) + ', root Ø' + f3(m8.minor),
      m8.major === 8 && m8.P === 1.25 && m8.angle === 60 && near(m8.h, 0.61343 * 1.25, 1e-9) && near(m8.fc, 1.25 / 8, 1e-9) && near(m8.fr, 1.25 / 6, 2e-4) && near(m8.minor, 8 - 2 * 0.61343 * 1.25, 1e-9));
    check('the profile adds up: crest + root + 2 flanks = one pitch, for every table size',
      T.sizeIds().every(id => { const s = T.spec(id); if (!s.ok) return true; const q = s.spec; return near(q.fc + q.fr + 2 * q.w, q.P, 1e-9) && q.fr > 0 && q.fc > 0; }));
    const g = T.spec('G1/2').spec;
    check('G1/2 (BSP parallel): Ø20.955, 14 TPI = ' + f3(g.P) + ' mm, 55°, depth 0.6403 P, crest and root flats P/6', near(g.major, 20.955, 1e-9) && near(g.P, 25.4 / 14, 1e-9) && g.angle === 55 && near(g.h, 0.640327 * g.P, 1e-9) && near(g.fc, g.P / 6, 1e-9) && near(g.fr, g.P / 6, 1e-4));
    const n = T.spec('NPT3/4').spec;
    check('NPT3/4: Ø26.67, 14 TPI, tapered 1:16 on the diameter (1/32 a side)', near(n.major, 26.67, 1e-9) && near(n.P, 25.4 / 14, 1e-9) && near(n.taper, 1 / 16, 1e-12) && near(n.slope, 1 / 32, 1e-12));
    check('a typed Ø and pitch: { major: 7, pitch: 1.5 } is a thread of its own', (() => { const c = T.spec({ family: 'metric', major: 7, pitch: 1.5 }); return c.ok && c.spec.major === 7 && c.spec.P === 1.5; })());
    const nm = (a, o) => T.spec(a, o || {}).spec.id;
    check('a thread is named for what it is: the table\'s id when Ø and pitch are the table\'s (G1/2 even at 20.955 typed), else its numbers - M8, M7x1.25, M7x1.5, Ø20.96x2',
      nm('M8') === 'M8' && nm('G1/2', { major: 20.955 }) === 'G1/2' && nm('M8', { major: 7 }) === 'M7x1.25' && nm({ family: 'metric', major: 7, pitch: 1.5 }) === 'M7x1.5' && nm('G1/2', { pitch: 2 }) === 'Ø20.96x2',
      [nm('M8'), nm('M8', { major: 7 }), nm('G1/2', { pitch: 2 })].join(' / '));
    const no = (tag, r, re) => { console.log('   ' + r.reason); check('refused: ' + tag, !r.ok && re.test(r.reason), r.reason); };
    no('an unknown size', T.spec('M99'), /^unknown thread size "M99"/);
    no('a pitch under half a nozzle of depth', T.spec({ family: 'metric', major: 6, pitch: 0.2 }), /^a 0\.20 mm pitch is only 0\.123 mm deep - under 0\.5 of a 0\.4 mm nozzle; it would not form\. Use a pitch of at least 0\.33 mm$/);
    no('a pitch too coarse for the Ø', T.spec({ family: 'metric', major: 6, pitch: 3 }), /^a pitch of 3\.00 mm is too coarse for a Ø6\.00 thread/);
    no('no pitch', T.spec({ family: 'metric', major: 6 }), /^enter the thread's pitch in mm, more than 0$/);
    const soft = T.spec('M3');
    check('M3 (0.5 mm pitch) is allowed, with a note that a 0.4 nozzle resolves it roughly', soft.ok && /finer than a 0\.4 mm nozzle resolves well/.test(soft.note), soft.note);
    check('M6 (1 mm pitch) carries no note', T.spec('M6').note === '');
  }

  /* ================================================================== THE ROD */
  console.log('\n=== 2. the threaded rod: the profile, measured by rays ===');
  for (const [size, L] of [['M8', 20], ['M12', 18], ['M5', 12], ['G1/2', 24], ['NPT1/2', 22]]) {
    const r = T.rod({ size, length: L });
    check(size + ' rod: made', r.ok, r.reason);
    if (!r.ok) continue;
    const sp = r.info.spec, s = r.soup, tag = size + ' rod ' + L;
    console.log('   ' + r.reason);
    closed(tag, s, 2, size !== 'M12');
    const N = T.columnsFor(sp.R);
    // profile at theta = 0 (a vertex column: exact) over one pitch, well away from both ends
    const z0 = L / 2, slope = 0;                                  // a rod is straight; the taper belongs to male / female ENDS
    const pts = profileAt(s, 0, z0, sp.P, 400);
    const rs = pts.map(p => p[1] - slope * 0);   // the taper makes r(z) lean: compare within one pitch with its own slope removed
    const rMaxM = Math.max(...pts.map(p => p[1] + slope * (p[0] - z0))), rMinM = Math.min(...pts.map(p => p[1] + slope * (p[0] - z0)));
    // a tapered thread narrows with z (a male narrows toward its free end: slope sign per piece), so remove the lean
    check(tag + ': crests Ø' + f3(2 * rMaxM) + ' = ' + f3(sp.major) + ' (the nominal), roots Ø' + f3(2 * rMinM) + ' = ' + f3(sp.minor),
      near(rMaxM, sp.R, 2e-3) && near(rMinM, sp.R - sp.h, 2e-3), f3(rMaxM) + ' / ' + f3(rMinM));
    // pitch: successive rising flanks at the same angle are one pitch apart
    const mid = sp.R - sp.h / 2;
    const zs = [];
    for (let k = 0; k < 4; k++) {
      let lo = z0 + k * sp.P, found = null;
      const prof = profileAt(s, 0, lo, sp.P, 800);
      for (let i = 0; i + 1 < prof.length; i++) {
        const lvl = mid + slope * (prof[i][0] - z0);
        if (prof[i][1] < lvl && prof[i + 1][1] >= lvl + slope * (prof[i + 1][0] - prof[i][0])) { found = prof[i][0]; break; }
      }
      zs.push(found);
    }
    const dz = zs.slice(1).map((z, i) => z - zs[i]);
    check(tag + ': rising flanks at one angle are a pitch apart: ' + dz.map(f3).join(' / ') + ' (P = ' + f3(sp.P) + ')', dz.length === 3 && dz.every(d => near(d, sp.P, 3e-3)), dz.map(f3).join(' / '));
    // volume: closed form
    const Vexp = L * analyticPerLength(sp, N, 0);
    const vol = volume(s);
    check(tag + ': volume ' + f3(vol) + ' vs closed form ' + f3(Vexp) + ' (' + ((vol / Vexp - 1) * 100).toFixed(3) + ' %)', Math.abs(vol / Vexp - 1) < 0.002);
    // the ends are flat: z = 0 and z = L, and the whole length is the length asked
    const bb = bbox(s);
    check(tag + ': flat ends at z = 0 and z = ' + L + ' (box ' + f3(bb.lo[2]) + '..' + f3(bb.hi[2]) + ')', near(bb.lo[2], 0, 1e-5) && near(bb.hi[2], L, 1e-5));
    TABLE.push({ name: tag, tris: s.length / 9 });
  }
  {
    // hand: at a quarter turn the profile has moved a quarter pitch along z - up for a right-hand thread, down for a left
    for (const hand of ['right', 'left']) {
      const r = T.rod({ size: 'M10', length: 20, hand }), sp = r.info.spec, mid = sp.R - sp.h / 2;
      const rise = th => { const pr = profileAt(r.soup, th, 8, sp.P, 1500); for (let i = 0; i + 1 < pr.length; i++) if (pr[i][1] < mid && pr[i + 1][1] >= mid) return pr[i][0] + (pr[i + 1][0] - pr[i][0]) * (mid - pr[i][1]) / (pr[i + 1][1] - pr[i][1]); return null; };
      const a = rise(0), b = rise(Math.PI / 2);
      let d = b - a; d -= Math.round(d / sp.P) * sp.P;
      const want = (hand === 'right' ? 1 : -1) * sp.P / 4;
      check(hand + '-hand M10: a quarter turn moves the thread ' + f3(d) + ' mm along the axis (' + f3(want) + ' = ' + (hand === 'right' ? '+' : '-') + 'P/4)', near(d, want, 2e-3), f3(d));
      // and a turn about the axis at the same z is the screw motion: the cross-section at z and at z + P/4 is the same curve, turned
      const th0 = radius(r.soup, 0, 10), thq = radius(r.soup, Math.PI / 2, 10 + (hand === 'right' ? 1 : -1) * sp.P / 4);
      check(hand + '-hand M10: screwing the cross-section on by a quarter pitch turns it a quarter turn (' + f3(th0) + ' = ' + f3(thq) + ')', near(th0, thq, 5e-3));
    }
  }

  /* ================================================================ BOLT, NUT */
  console.log('\n=== 3. the bolt and the nut ===');
  for (const [size, L] of [['M8', 25], ['M3', 10], ['M20', 30]]) {
    const b = T.bolt({ size, length: L });
    console.log('   ' + (b.reason || ''));
    check(size + ' hex bolt: made', b.ok, b.reason);
    if (!b.ok) continue;
    const I = b.info, sp = I.spec;
    closed(size + ' hex bolt', b.soup, 2, size === 'M20');
    const hb = bbox(b.soup, 0, I.headK);
    check(size + ' bolt head: ' + f3(I.headAF) + ' across flats (box in y ' + f3(hb.hi[1] - hb.lo[1]) + '), ' + f3(I.headK) + ' tall, head down on z = 0',
      near(hb.hi[1] - hb.lo[1], I.headAF, 1e-3) && near(hb.hi[0] - hb.lo[0], I.headAF / Math.cos(Math.PI / 6), 1e-3) && near(bbox(b.soup).lo[2], 0, 1e-5) && near(bbox(b.soup).hi[2], I.headK + L, 1e-5));
    const sh = bbox(b.soup, I.headK + sp.P * 2, I.headK + L);
    check(size + ' shank: crests Ø' + f3(2 * sh.hi[0]) + ' (nominal Ø' + sp.major + ')', near(sh.hi[0], sp.R, 2e-3));
    const Vexp = L * analyticPerLength(sp, T.columnsFor(sp.R), 0) + I.headAF * I.headAF * Math.sqrt(3) / 2 * I.headK;
    check(size + ' bolt volume ' + f3(volume(b.soup)) + ' vs head prism + threaded shank ' + f3(Vexp), Math.abs(volume(b.soup) / Vexp - 1) < 0.003);
  }
  {
    const b = T.bolt({ size: 'M8', length: 20, head: 'socket' }), I = b.info;
    console.log('   ' + b.reason);
    closed('M8 socket-head bolt', b.soup, 2);
    // up the axis from below: the socket's floor, then through the head to the shank's end
    const up = rayHits(b.soup, [0, 0, -5], [0, 0, 1]).map(d => d - 5);
    check('socket-head bolt: the socket is open on the bed, ' + f3(I.socketDepth) + ' deep, then solid to ' + f3(I.headK + 20) + ' (axis ray: ' + up.map(f3).join(' / ') + ')',
      up.length === 2 && near(up[0], I.socketDepth, 1e-6) && near(up[1], I.headK + 20, 1e-6));
    const sb = bbox(b.soup, 0, I.socketDepth - 0.01);
    check('socket-head bolt: head Ø' + f3(I.headD) + ' round, and the hex socket ' + I.socketAF + ' across flats (ray at 90° from the axis: wall at r ' + f3(radii(b.soup, Math.PI / 2, 1)[0]) + ')',
      near(sb.hi[0], I.headD / 2 / Math.cos(Math.PI / 96), 1e-3) && near(radii(b.soup, Math.PI / 2, 1)[0], I.socketAF / 2, 1e-3));
  }
  {
    // the nut, and the bolt in it
    const nt = T.nut({ size: 'M8' }), I = nt.info, sp = I.spec;
    console.log('   ' + nt.reason);
    closed('M8 hex nut', nt.soup, 0);
    const bb = bbox(nt.soup);
    check('M8 nut: ' + f3(I.af) + ' across flats, ' + I.thicknessMm + ' thick on z = 0, a ring (Euler 0)', near(bb.hi[1] - bb.lo[1], I.af, 1e-3) && near(bb.lo[2], 0, 1e-5) && near(bb.hi[2], I.thicknessMm, 1e-5));
    const bolt = T.rod({ size: 'M8', length: 30 });
    // the bore less the bolt, round the thread and along it
    let gmin = Infinity, gmax = -Infinity, n = 0;
    const N = T.columnsFor(sp.R + I.fitMm), Nb = T.columnsFor(sp.R);
    for (let i = 0; i < 24; i++) for (let j = 0; j < 12; j++) {
      const th = 2 * Math.PI * (i * (N / 24 | 0)) / N * (Nb === N ? 1 : 1), z = 1.5 + (I.thicknessMm - 3) * j / 11;
      const rb = radius(bolt.soup, th, z + 10), rn = radius(nt.soup, th, z);
      // same helix, same phase: the nut at height z is the bolt at height z
      const rb0 = radius(bolt.soup, th, z);
      if (rb0 == null || rn == null) continue;
      const g = rn - rb0; gmin = Math.min(gmin, g); gmax = Math.max(gmax, g); n++;
    }
    check('a bolt turns in the nut: bore less bolt over ' + n + ' places is ' + f3(gmin) + ' to ' + f3(gmax) + ' mm (the fit is 0.2; never under 0.19 and never touching)', n >= 200 && gmin > 0.19 && gmax < 0.215, f3(gmin) + '..' + f3(gmax));
    // thread flank clearance does not rely on same-phase luck: screw the bolt on by a third of a pitch and measure again
    let gmin2 = Infinity;
    for (let i = 0; i < 24; i++) for (let j = 0; j < 8; j++) {
      const phi = (i * (N / 24 | 0)) * 2 * Math.PI / N, z = 2 + j * 0.37, dz = sp.P * (phi / (2 * Math.PI));
      // turn the bolt by -phi: the bolt's point at angle th and height z was at th + phi, z - P phi / 2 pi...
      const rn = radius(nt.soup, phi, z), rb = radius(bolt.soup, 0, z - dz);
      if (rn != null && rb != null) gmin2 = Math.min(gmin2, rn - rb);
    }
    check('...and a bolt screwed in by a turn about the axis (the screw motion) still clears: least gap ' + f3(gmin2), gmin2 > 0.19, f3(gmin2));
    check('the nut\'s bore is the bolt\'s + 0.2 mm at crest and root: Ø' + f3(I.boreMajorMm) + ' / Ø' + f3(I.boreMinorMm), near(I.boreMajorMm, 8.4, 1e-9) && near(I.boreMinorMm, sp.minor + 0.4, 1e-9));
    const rn = T.nut({ size: 'M8', shape: 'round', fit: 0.3 });
    check('a round nut with a 0.3 fit: Ø13 outside, a ring', rn.ok && near(bbox(rn.soup).hi[0], 6.5 / Math.cos(Math.PI / 96), 1e-3) && topo(rn.soup).euler === 0, rn.reason);
    const lh = T.nut({ size: 'M8', hand: 'left' });
    check('a left-hand nut does not fit a right-hand bolt (the gap goes negative somewhere)', (() => { let g = Infinity; for (let i = 0; i < 24; i++) { const th = i * Math.PI / 12; g = Math.min(g, radius(lh.soup, th, 3.1) - radius(bolt.soup, th, 3.1)); } return g < 0; })());
  }
  console.log('\n=== 4. the bolt and nut\'s refusals ===');
  {
    const no = (tag, r, re) => { console.log('   ' + r.reason); check('refused: ' + tag, !r.ok && !r.soup && re.test(r.reason), r.reason); };
    no('a nut thinner than a pitch', T.nut({ size: 'M8', thickness: 1 }), /^a nut thinner than one pitch \(1\.25 mm\) does not engage - make it at least 2\.5 mm$/);
    no('a nut with too little wall', T.nut({ size: 'M8', af: 9 }), /^a 9\.0 across-flats nut leaves 0\.30 mm of wall round a Ø8\.40 thread - under the 0\.42 mm floor; make it at least 9\.3$/);
    no('a negative fit', T.nut({ size: 'M8', fit: -0.1 }), /^a fit of -0\.10 mm is refused/);
    no('a bolt head that does not clear the shank', T.bolt({ size: 'M8', headAF: 7 }), /^a hex head 7\.00 across flats does not clear a Ø8\.00 shank/);
    no('a rod shorter than a pitch', T.rod({ size: 'M8', length: 1 }), /^a rod shorter than one pitch \(1\.25 mm\) has no thread/);
    no('an unknown size', T.rod({ size: 'M99' }), /^unknown thread size/);
  }

  /* ========================================================= EVERY SIZE */
  console.log('\n=== 5. every size in the table builds, as rod and as nut: closed, one body, Euler 2 / 0 ===');
  {
    let bad = [], n = 0, tm = Date.now();
    for (const id of T.sizeIds()) {
      const sp = T.spec(id); if (!sp.ok) continue;
      const rod = T.rod({ size: id, length: Math.max(8, 4 * sp.spec.P) }), nt = T.nut({ size: id });
      const a = topo(rod.soup), b = nt.ok ? topo(nt.soup) : null;
      n++;
      if (!(a.open === 0 && a.nm === 0 && a.flip === 0 && a.degen === 0 && a.euler === 2 && volume(rod.soup) > 0)) bad.push(id + ' rod ' + JSON.stringify(a));
      if (!nt.ok) bad.push(id + ' nut refused: ' + nt.reason);
      else if (!(b.open === 0 && b.nm === 0 && b.flip === 0 && b.degen === 0 && b.euler === 0 && volume(nt.soup) > 0)) bad.push(id + ' nut ' + JSON.stringify(b));
    }
    check('all ' + n + ' sizes (' + T.sizeIds().join(' ') + ') build clean as a rod and as a nut', bad.length === 0, bad.slice(0, 3).join(' | ') + ' (' + (Date.now() - tm) + ' ms)');
  }

  /* ========================================================== PIPE PIECES */
  console.log('\n=== 6. pipe pieces: male and female ends, straight (G) and tapered (NPT) ===');
  for (const [kind, o] of [['nipple', { size: 'G1/2' }], ['coupler', { size: 'G1/2' }], ['adapter', { size: 'G1/2', size2: 'G3/4' }], ['plug', { size: 'G1/2' }], ['cap', { size: 'G1/2' }],
                           ['nipple', { size: 'NPT1/2' }], ['coupler', { size: 'NPT3/4' }], ['adapter', { size: 'NPT1/2', size2: 'G1/2' }], ['nipple', { size: 'G1/4' }],
                           ['adapter', { size: 'G3/4', size2: 'G1/2' }], ['adapter', { size: 'G1/2', size2: 'G3/4' }], ['adapter', { size: 'M20', size2: 'G1/2' }]]) {
    const f = T.fitting(Object.assign({ kind }, o));
    console.log('   ' + f.reason);
    check(kind + ' ' + o.size + (o.size2 ? ' / ' + o.size2 : '') + ': made', f.ok, f.reason);
    if (!f.ok) continue;
    const I = f.info, solid = kind === 'plug' || kind === 'cap', tag = kind + ' ' + o.size + (o.size2 ? '-' + o.size2 : '');
    closed(tag, f.soup, solid ? 2 : 0);
    const bb = bbox(f.soup);
    check(tag + ': ' + f3(I.heightMm) + ' mm tall on z = 0, hex collar ' + I.af + ' across flats', near(bb.lo[2], 0, 1e-5) && near(bb.hi[2], I.heightMm, 1e-5) && near(bb.hi[1] - bb.lo[1], Math.max(I.af, 0), 1e-3) );
    if (!solid) {
      const ax = rayHits(f.soup, [0.0, 0, -5], [0, 0, 1]);
      check(tag + ': a clear bore all the way through (axis ray meets nothing)', ax.length === 0);
      const w = radii(f.soup, Math.PI / 2, I.heightMm / 2)[0];
      check(tag + ': the collar\'s bore is Ø' + f3(I.boreMm) + ' (wall at r ' + f3(w) + ')', near(w, I.boreMm / 2, 1e-3 + I.boreMm / 2 * 0.0006));
    }
    // the male thread's wall under its root is the wall asked
    if (kind === 'nipple' || kind === 'plug') {
      const sp = I.spec;
      let lowest = Infinity;
      for (let k = 0; k < 40; k++) { const z = 2 + (I.threadMm - 4) * k / 39; const r = radii(f.soup, 0, z); if (solid) { const rr = r[0]; if (rr != null) lowest = Math.min(lowest, rr); } else if (r.length >= 2) lowest = Math.min(lowest, r[1] - r[0]); }
      if (!solid) check(tag + ': the thread\'s thinnest wall (root to bore) is ' + f3(lowest) + ' mm - not under the ' + I.wallMm + ' mm asked', lowest >= I.wallMm - 2e-3, f3(lowest));
    }
    TABLE.push({ name: tag, tris: f.soup.length / 9 });
  }
  {
    // a nipple's male thread goes into a coupler's female thread of the same size: gap all round
    const nip = T.fitting({ kind: 'nipple', size: 'G1/2' }), cou = T.fitting({ kind: 'coupler', size: 'G1/2' });
    const Lt = nip.info.threadMm;
    let gmin = Infinity, gmax = -Infinity;
    for (let i = 0; i < 32; i++) for (let j = 0; j < 8; j++) {
      const th = i * Math.PI / 16, z = 1.5 + (Lt - 3) * j / 7;
      const rm = radii(nip.soup, th, z)[1];                          // the male thread's radius at (th, z): the second hit - the first is its flow bore
      const rf = radii(cou.soup, th, z).filter(r => r > 0)[0];       // the female bore's, same height, same phase
      gmin = Math.min(gmin, rf - rm); gmax = Math.max(gmax, rf - rm);
    }
    check('G1/2 male thread in a G1/2 female: the bore less the thread is ' + f3(gmin) + ' to ' + f3(gmax) + ' (the 0.2 fit all round, never touching)', gmin > 0.17 && gmax < 0.23, f3(gmin) + '..' + f3(gmax));
  }
  {
    // taper: a tapered male narrows toward its free end by 1/32 a side per mm; a tapered female opens to its mouth.
    // Compare the SAME place on the profile - the middle of a crest flat at angle 0, one pitch apart - so the helix drops out.
    const n = T.fitting({ kind: 'nipple', size: 'NPT1/2' }), I = n.info, sp = I.spec, Lt = I.threadMm;
    const zCrest = sp.fr + sp.w + sp.fc / 2, zRoot = sp.fr / 2, k0 = 1, k1 = Math.floor((Lt - 2 - zCrest) / sp.P);
    const span = (k1 - k0) * sp.P, want = span * sp.slope;
    const lo0 = radii(n.soup, 0, zCrest + k0 * sp.P)[1], lo1 = radii(n.soup, 0, zCrest + k1 * sp.P)[1];
    check('NPT male (lower thread, free end at z = 0): the crest grows ' + f3(lo1 - lo0) + ' mm over ' + f3(span) + ' mm of thread (1/32 a side = ' + f3(want) + ')', near(lo1 - lo0, want, 1e-3), f3(lo1 - lo0));
    const zTop = I.heightMm - Lt;                                  // the upper thread starts here
    const j0 = Math.ceil((zTop + 1 - zCrest) / sp.P), j1 = j0 + k1 - k0;
    const up0 = radii(n.soup, 0, zCrest + j0 * sp.P)[1], up1 = radii(n.soup, 0, zCrest + j1 * sp.P)[1];
    check('NPT male (upper thread, free end at the top): the crest shrinks toward it by ' + f3(up0 - up1) + ' over the same ' + f3(span), near(up0 - up1, want, 1e-3), f3(up0 - up1));
    const c = T.fitting({ kind: 'coupler', size: 'NPT1/2' });
    const m0 = radii(c.soup, 0, zRoot + k0 * sp.P)[0], m1 = radii(c.soup, 0, zRoot + k1 * sp.P)[0];
    check('NPT female (lower, mouth at z = 0): the bore narrows with depth by ' + f3(m0 - m1) + ' over ' + f3(span), near(m0 - m1, want, 1e-3), f3(m0 - m1));
    const g = T.fitting({ kind: 'nipple', size: 'G1/2' }), gs = g.info.spec;
    const g0 = radii(g.soup, 0, gs.fr + gs.w + gs.fc / 2 + gs.P)[1], g1 = radii(g.soup, 0, gs.fr + gs.w + gs.fc / 2 + 4 * gs.P)[1];
    check('a straight G thread has no taper: crest ' + f3(g0) + ' = ' + f3(g1), near(g0, g1, 1e-3));
  }
  console.log('\n=== 7. the pipe pieces\' refusals ===');
  {
    const no = (tag, r, re) => { console.log('   ' + r.reason); check('refused: ' + tag, !r.ok && !r.soup && re.test(r.reason), r.reason); };
    no('a kind that is not one', T.fitting({ kind: 'tee' }), /^a fitting is a nipple, coupler, adapter, plug or cap$/);
    no('a thread too short', T.fitting({ kind: 'nipple', size: 'G1/2', thread: 3 }), /^a thread length of 3\.0 mm is under two pitches/);
    no('a wall under the floor', T.fitting({ kind: 'nipple', size: 'G1/2', wall: 0.3 }), /^a 0\.30 mm wall is under the nozzle-safety floor of 0\.42 mm/);
    no('a bore too wide for the thread\'s root', T.fitting({ kind: 'nipple', size: 'G1/2', bore: 18 }), /^a Ø18\.00 bore leaves .* under the thread's root - under the 1\.60 mm wall; make the bore at most /);
    no('a flow bore between a female thread\'s crests and roots (it would cut across the thread)', T.fitting({ kind: 'adapter', size: 'G3/4', size2: 'G1/2', bore: 20.5 }), /^a Ø20\.50 bore cuts into the thread's crests - there is no wall left; make the bore at most 15\.\d+ mm$/);
    no('a collar too small for the thread', T.fitting({ kind: 'coupler', size: 'G1/2', af: 22 }), /^a 22\.0 across-flats collar leaves under 1\.60 mm of wall round the thread - make it at least 24\.6$/);
    no('a size too small for a pipe fitting', T.fitting({ kind: 'nipple', size: 'M3' }), /^the flow bore would be Ø/);
  }
  console.log('\n=== 8. the sleeve: a tube slips in one end, a thread at the other ===');
  for (const end of ['male', 'female']) {
    const r = T.sleeve({ tubeOd: 16, tubeWall: 2, size: 'G1/2', end }), I = r.info;
    console.log('   ' + r.reason);
    check(end + ' sleeve: made', r.ok, r.reason);
    if (!r.ok) continue;
    closed(end + ' sleeve', r.soup, 0);
    // the socket: along the sleeve's wall at the middle of the tube's depth: bore r = od/2 + gap, wall = the tube's
    const h = radii(r.soup, 0, I.depthMm / 2);
    // r.soup is an n-gon: measure on a flat (the mid-angle), where the apothem is
    const hh = radii(r.soup, Math.PI / 96, I.depthMm / 2);
    check(end + ' sleeve: socket bore Ø' + f3(2 * hh[0]) + ' ≈ the tube\'s Ø16 + 2 x 0.25 = 16.5 (flats), wall ' + f3(hh[1] - hh[0]) + ' = the tube\'s 2',
      near(hh[0], 8.25, 2e-3) && near(hh[1] - hh[0], 2, 2e-3), hh.map(f3).join(' / '));
    // the ledge: up the axis-parallel line at the tube's bore radius - the tube's end stops on the collar's floor at z = depth
    const ledge = rayHits(r.soup, [I.boreMm / 2 + 0.5, 0, -3], [0, 0, 1]).map(d => d - 3);
    check(end + ' sleeve: the tube stops on a ledge at z = ' + f3(I.depthMm) + ' (a ray up the wall of the tube\'s bore: ' + ledge.map(f3).join(' / ') + ')', ledge.length >= 2 && ledge.some(d => near(d, I.depthMm, 1e-6)));
    const axis = rayHits(r.soup, [0, 0, -3], [0, 0, 1]);
    check(end + ' sleeve: open through (the axis meets nothing), ' + f3(I.heightMm) + ' mm tall, the tube end down on z = 0', axis.length === 0 && near(bbox(r.soup).lo[2], 0, 1e-5) && near(bbox(r.soup).hi[2], I.heightMm, 1e-5));
  }
  {
    const no = (tag, r, re) => { console.log('   ' + r.reason); check('refused: ' + tag, !r.ok && !r.soup && re.test(r.reason), r.reason); };
    no('no tube Ø', T.sleeve({ tubeWall: 2 }), /^enter the tube's outside Ø in mm, more than 0$/);
    no('a negative gap', T.sleeve({ tubeOd: 16, tubeWall: 2, gap: -1 }), /^a fit gap of -1\.00 mm is refused/);
    no('a bore too wide for the thread\'s root', T.sleeve({ tubeOd: 16, tubeWall: 2, size: 'G1/2', end: 'male', bore: 17 }), /under the G1\/2 thread's root/);
    no('a thread too small to carry the tube', T.sleeve({ tubeOd: 16, tubeWall: 2, size: 'M3', end: 'male' }), /^the flow bore would be Ø/);
  }

  /* =============================================================== CUTTER */
  console.log('\n=== 9. the tapped-hole cutter ===');
  {
    const c = T.cutter('M6', 10, {}), sp = c.info.spec;
    check('M6 cutter: made, flat-ended 0..10, Ø6.4 at the crests (the bolt\'s + 0.2 fit a side)', c.ok && near(bbox(c.soup).lo[2], 0, 1e-5) && near(bbox(c.soup).hi[2], 10, 1e-5) && near(bbox(c.soup, 2, 8).hi[0], 3.2, 2e-3), c.ok ? f3(bbox(c.soup, 2, 8).hi[0]) : c.reason);
    closed('M6 cutter', c.soup, 2);
    const r6 = T.rod({ size: 'M6', length: 10 });
    let g = Infinity;
    for (let i = 0; i < 24; i++) for (let j = 0; j < 8; j++) { const th = i * Math.PI / 12, z = 2 + j * 0.9; g = Math.min(g, radius(c.soup, th, z) - radius(r6.soup, th, z)); }
    check('the M6 bolt Fasteners makes goes in the hole this cutter leaves: least clearance ' + f3(g) + ' (the 0.2 fit)', g > 0.19, f3(g));
    const t = T.cutter('NPT1/2', 14, { slope: -1 / 32 }), tp = t.info.spec, zc = tp.fr + tp.w + tp.fc / 2;
    const a = radius(t.soup, 0, zc + tp.P), b = radius(t.soup, 0, zc + 5 * tp.P);
    check('a tapered cutter narrows with depth (NPT, 1/32 a side): the same crest point runs ' + f3(a) + ' -> ' + f3(b) + ' over 4 pitches (' + f3(4 * tp.P / 32) + ' expected)', t.ok && near(a - b, 4 * tp.P / 32, 1e-3), f3(a - b));
    check('a cutter with no depth is refused in words', (() => { const x = T.cutter('M6', 0, {}); return !x.ok && /^the thread needs a depth, more than 0$/.test(x.reason); })());
  }

  /* ======================================================== SCALE, SPEED */
  console.log('\n=== 10. scale: a big thread builds in well under a second ===');
  {
    const t0 = Date.now();
    const r = T.rod({ size: 'M30', length: 80 }), dt = Date.now() - t0;
    const tp = topo(r.soup);
    check('M30 × 80 rod: ' + tp.tris + ' triangles in ' + dt + ' ms, closed', dt < 2000 && tp.open === 0 && tp.nm === 0 && tp.euler === 2, dt + ' ms');
    const t1 = Date.now(), q = T.fitting({ kind: 'coupler', size: 'G2' }), d2 = Date.now() - t1;
    check('G2 coupler: ' + q.soup.length / 9 + ' triangles in ' + d2 + ' ms', q.ok && d2 < 3000, d2 + ' ms');
  }

  console.log('\n' + (fail ? fail + ' FAILED: ' + FAILS.join('; ') : 'all ' + pass + ' checks passed') );
  console.log('\n' + TABLE.map(r => '  ' + r.name.padEnd(28) + String(r.tris).padStart(8) + ' tris').join('\n'));
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* tmp */ }
  process.exit(fail ? 1 : 0);
})();

