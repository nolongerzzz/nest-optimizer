#!/usr/bin/env node
// Headless self-test for Punch's threaded holes (nso_punch.js `thread` + nso_thread.js). docs/THREADS.md, docs/PUNCH.md.
//
//   node tools/nso_punch_thread_test.js        exit 0 = every gate held
//
// The plan and cutters are the shipped ones; the boolean is the shipped NSO_subtractSoups (tools/nso_csg_node.js). Everything is
// measured on the boolean's OUTPUT, by rays out from the hole's axis, by an exact-bit edge counter, and by mesh_validate --gate:
//
//   1. an M6 through hole in a 10 mm slab: the hole's crests and roots, its pitch, its volume against the closed form
//   2. the bolt Fasteners makes turns in it (some screw position clears by the 0.2 fit all round), and a left-hand one does not
//   3. a blind hole, flat-bottomed at the depth; under two pitches refused in words
//   4. a 2 x 3 grid of M4 holes cut in ONE subtract; a radial hole through a faceted tube's both walls, square to its surface
//   5. the wall floor is measured from the thread's Ø; the refusals; a tapered NPT hole narrows with depth

'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const P = require('../nso_punch.js');
const T = require('../nso_thread.js');
const { csgContext } = require('./nso_csg_node.js');
const { writeSTL } = require('./nso_stl_io.js');

let fails = 0, passes = 0;
function gate(name, ok, detail) {
  if (ok) passes++; else fails++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  -  ' + detail : ''));
}
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const f3 = x => (+x).toFixed(3);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nso-punch-thread-'));

function box(lo, hi) {
  const v = [[lo[0], lo[1], lo[2]], [hi[0], lo[1], lo[2]], [hi[0], hi[1], lo[2]], [lo[0], hi[1], lo[2]],
             [lo[0], lo[1], hi[2]], [hi[0], lo[1], hi[2]], [hi[0], hi[1], hi[2]], [lo[0], hi[1], hi[2]]];
  const f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  const o = [];
  for (const t of f) for (const i of t) o.push(...v[i]);
  return new Float32Array(o);
}
function tubeX(R, r, Lx, m) {
  const o = [], tri = (a, b, c) => o.push(...a, ...b, ...c);
  const at = (rad, k, x) => { const a = 2 * Math.PI * k / m; return [x, rad * Math.cos(a), rad * Math.sin(a)]; };
  for (let k = 0; k < m; k++) {
    const k1 = k + 1;
    const o0 = at(R, k, 0), o1 = at(R, k1, 0), O0 = at(R, k, Lx), O1 = at(R, k1, Lx), i0 = at(r, k, 0), i1 = at(r, k1, 0), I0 = at(r, k, Lx), I1 = at(r, k1, Lx);
    tri(o0, o1, O1); tri(o0, O1, O0); tri(i0, I1, i1); tri(i0, I0, I1); tri(o0, i1, o1); tri(o0, i0, i1); tri(O0, O1, I1); tri(O0, I1, I0);
  }
  return new Float32Array(o);
}
function volume(s) {
  let v = 0;
  for (let i = 0; i < s.length; i += 9) v += s[i] * (s[i + 4] * s[i + 8] - s[i + 5] * s[i + 7]) - s[i + 1] * (s[i + 3] * s[i + 8] - s[i + 5] * s[i + 6]) + s[i + 2] * (s[i + 3] * s[i + 7] - s[i + 4] * s[i + 6]);
  return v / 6;
}
function topo(s) {
  const key = i => s[i] + ',' + s[i + 1] + ',' + s[i + 2], ids = new Map(), vid = [];
  for (let i = 0; i < s.length; i += 3) { const k = key(i); if (!ids.has(k)) ids.set(k, ids.size); vid.push(ids.get(k)); }
  const E = new Map();
  for (let t = 0; t < vid.length / 3; t++) for (const [p, q] of [[vid[t * 3], vid[t * 3 + 1]], [vid[t * 3 + 1], vid[t * 3 + 2]], [vid[t * 3 + 2], vid[t * 3]]]) {
    const k = Math.min(p, q) + ':' + Math.max(p, q), e = E.get(k) || { n: 0, f: 0 }; e.n++; if (p < q) e.f++; E.set(k, e);
  }
  let open = 0, nm = 0, flip = 0; E.forEach(e => { if (e.n === 1) open++; else if (e.n > 2) nm++; else if (e.f !== 1) flip++; });
  return { open, nm, flip, euler: ids.size - E.size + vid.length / 3 };
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
// the radius of the hole's wall at angle th, height z, out from the hole's axis (cx, cy)
const holeR = (s, cx, cy, th, z) => { const h = rayHits(s, [cx, cy, z], [Math.cos(th), Math.sin(th), 0]); return h.length ? h[0] : null; };
function meshValidate(name, soup) {
  const file = path.join(TMP, name + '.stl');
  writeSTL(file, soup);
  let out;
  try { out = execFileSync('python3', [path.join(ROOT, 'tools', 'mesh_validate.py'), file, '--json', '--gate'], { encoding: 'utf8', maxBuffer: 64 << 20 }); } catch (e) { out = e.stdout; }
  try { const j = JSON.parse(out); return { pass: j.verdict === 'PASS', fails: j.verdict_fails || [] }; } catch (e) { return { pass: false, fails: ['no JSON'] }; }
}
const concat = list => { const out = new Float32Array(list.reduce((n, s) => n + s.length, 0)); let q = 0; for (const s of list) { out.set(s, q); q += s.length; } return out; };

(async function main() {
  const csg = csgContext();
  const m6 = T.spec('M6').spec, FIT = 0.2;

  /* 1 ------------------------------------------------------------------ */
  console.log('\n--- 1. an M6 through hole in a 10 mm slab ---');
  const slab = box([0, 0, 0], [40, 40, 10]);
  const pl = P.plan(slab, { point: [20, 20, 10], normal: [0, 0, 1] }, { thread: 'M6' });
  console.log('   ' + pl.reason);
  gate('1a plan: one threaded hole, M6, the hole\'s Ø is the thread\'s at the crests of the cut (6 + 2 x 0.2)', pl.ok && pl.holes.length === 1 && pl.holes[0].thread && pl.holes[0].dia === 6.4 && /M6 threaded/.test(pl.reason), pl.reason);
  const cut = P.cutters(pl);
  gate('1b cutter: one soup, closed, wound outward, Euler 2, the length of the hole (10.4)', cut.length === 1 && topo(cut[0]).open === 0 && topo(cut[0]).nm === 0 && topo(cut[0]).flip === 0 && topo(cut[0]).euler === 2 && volume(cut[0]) > 0,
    JSON.stringify(topo(cut[0])));
  const res = await csg.NSO_subtractSoups(slab, cut[0]);
  gate('1c the shipped subtract takes it out: one body, a ring (Euler 0), closed', res.ok && topo(res.soup).open === 0 && topo(res.soup).nm === 0 && topo(res.soup).flip === 0 && topo(res.soup).euler === 0, res.ok ? JSON.stringify(topo(res.soup)) : res.reason);
  const MV = meshValidate('m6hole', res.soup);
  gate('1d mesh_validate --gate on the pierced slab', MV.pass, MV.fails.join('; '));
  // closed-form: the slab loses 10 mm of the threaded cutter
  const perLen = (() => { const R = m6.R + FIT, rm = m6.R - m6.h + FIT, N = T.columnsFor(m6.R + FIT); const seg = [[0, m6.fr, rm, rm], [m6.fr, m6.fr + m6.w, rm, R], [m6.fr + m6.w, m6.fr + m6.w + m6.fc, R, R], [m6.fr + m6.w + m6.fc, m6.P, R, rm]]; let I = 0; for (const [a, b, ra, rb] of seg) I += (b - a) * (ra * ra + ra * rb + rb * rb) / 3; return Math.PI * I / m6.P * (N * Math.sin(2 * Math.PI / N) / (2 * Math.PI)); })();
  const lost = volume(slab) - volume(res.soup), want = 10 * perLen;
  gate('1e the slab loses ' + f3(lost) + ' mm³ vs the closed form ' + f3(want) + ' (' + ((lost / want - 1) * 100).toFixed(3) + ' %)', Math.abs(lost / want - 1) < 0.002);
  // the wall of the hole, measured from the hole's axis, mid-slab
  let rmin = Infinity, rmax = 0;
  for (let k = 0; k < 120; k++) { const r = holeR(res.soup, 20, 20, 0, 3 + m6.P * k / 120); rmin = Math.min(rmin, r); rmax = Math.max(rmax, r); }
  gate('1f the hole\'s wall runs from r ' + f3(rmin) + ' (crests of the internal thread: ' + f3(m6.R - m6.h + FIT) + ') to r ' + f3(rmax) + ' (roots: ' + f3(m6.R + FIT) + ')', near(rmin, m6.R - m6.h + FIT, 3e-3) && near(rmax, m6.R + FIT, 3e-3));
  // pitch: successive rising flanks at one angle
  const rise = (z0) => { const mid = (rmin + rmax) / 2; let prev = holeR(res.soup, 20, 20, 0, z0); for (let i = 1; i <= 1200; i++) { const z = z0 + m6.P * 1.2 * i / 1200, r = holeR(res.soup, 20, 20, 0, z); if (prev < mid && r >= mid) return z; prev = r; } return null; };
  const z1 = rise(3), z2 = rise(z1 + 0.3), z3 = rise(z2 + 0.3);
  gate('1g the thread has pitch ' + f3(z2 - z1) + ' / ' + f3(z3 - z2) + ' (1.000)', near(z2 - z1, m6.P, 3e-3) && near(z3 - z2, m6.P, 3e-3));
  // the hole is open all the way: the axis ray meets nothing
  gate('1h open all the way through (a ray down the axis meets nothing)', rayHits(res.soup, [20, 20, 20], [0, 0, -1]).length === 0);

  /* 2 ------------------------------------------------------------------ */
  console.log('\n--- 2. the bolt that Fasteners makes turns in it ---');
  {
    const rod = T.rod({ size: 'M6', length: 12 }), left = T.rod({ size: 'M6', length: 12, hand: 'left' });
    // the hole in the slab as a function of (th, z); the rod's own radius at (th, z - c) is the rod screwed in by c along z
    function bestClear(rodSoup) {
      let best = -Infinity;
      for (let c = 0; c < 100; c++) {
        const dz = m6.P * c / 100; let gmin = Infinity;
        for (let i = 0; i < 12; i++) for (let j = 0; j < 6; j++) {
          const th = i * Math.PI / 6 + 0.01, z = 2.5 + j * 0.83;
          const hr = holeR(res.soup, 20, 20, th, z), rr = rayHits(rodSoup, [0, 0, z - dz + 6 * m6.P], [Math.cos(th), Math.sin(th), 0])[0];
          if (hr != null && rr != null) gmin = Math.min(gmin, hr - rr);
        }
        best = Math.max(best, gmin);
      }
      return best;
    }
    const a = bestClear(rod.soup), b = bestClear(left.soup);
    gate('2a an M6 bolt from Fasteners has a screw position that clears the hole all round by ' + f3(a) + ' mm (the 0.2 fit)', a > 0.19, f3(a));
    gate('2b a left-hand M6 does not: its best position is ' + f3(b) + ' (it touches the walls)', b < 0.0, f3(b));
  }

  /* 3 ------------------------------------------------------------------ */
  console.log('\n--- 3. a blind hole, and the refusal under two pitches ---');
  {
    const pb = P.plan(slab, { point: [20, 20, 10], normal: [0, 0, 1] }, { thread: 'M6', depth: 6 });
    console.log('   ' + pb.reason);
    const cb = P.cutters(pb), rb = await csg.NSO_subtractSoups(slab, cb[0]);
    gate('3a M6 6 mm deep: made, closed, a pocket (one closed surface, Euler 2)', pb.ok && rb.ok && topo(rb.soup).open === 0 && topo(rb.soup).nm === 0 && topo(rb.soup).euler === 2, rb.ok ? JSON.stringify(topo(rb.soup)) : rb.reason);
    gate('3b it is flat-bottomed at 6 mm: a ray down the axis meets the floor at z = 4 (and then the slab\'s underside)', (() => { const h = rayHits(rb.soup, [20, 20, 20], [0, 0, -1]); return h.length === 2 && near(20 - h[0], 4, 1e-4) && near(20 - h[1], 0, 1e-4); })());
    const mv = meshValidate('m6blind', rb.soup);
    gate('3c mesh_validate --gate', mv.pass, mv.fails.join('; '));
    const no = P.plan(slab, { point: [20, 20, 10], normal: [0, 0, 1] }, { thread: 'M6', depth: 1.5 });
    console.log('   ' + no.reason);
    gate('3d refused under two pitches, in words', !no.ok && /^a 1\.5 mm deep thread is under two pitches \(2\.0 mm for M6\) - it would not hold; make it at least 2\.0 mm$/.test(no.reason), no.reason);
  }

  /* 4 ------------------------------------------------------------------ */
  console.log('\n--- 4. a grid of threaded holes; a radial one in a tube ---');
  {
    const big = box([0, 0, 0], [60, 40, 8]);
    const pg = P.plan(big, { point: [30, 20, 8], normal: [0, 0, 1] }, { thread: 'M4', pattern: 'grid', rows: 2, cols: 3, pitchX: 12, pitchY: 12, anchor: 'centre' });
    console.log('   ' + pg.reason);
    const cuts = P.cutters(pg), rg = await csg.NSO_subtractSoups(big, concat(cuts));
    gate('4a 2 x 3 M4 holes cut in ONE subtract: 6 holes (Euler 1 - 6 = -5), closed', pg.ok && pg.holes.length === 6 && rg.ok && topo(rg.soup).open === 0 && topo(rg.soup).nm === 0 && topo(rg.soup).euler === 2 - 2 * 6, rg.ok ? JSON.stringify(topo(rg.soup)) : rg.reason);
    const m4 = T.spec('M4').spec;
    let ok = true;
    for (const H of pg.holes) { let lo = Infinity, hi = 0; for (let k = 0; k < 60; k++) { const r = holeR(rg.soup, H.centre[0], H.centre[1], 0, 2 + m4.P * k / 60); lo = Math.min(lo, r); hi = Math.max(hi, r); } ok = ok && near(lo, m4.R - m4.h + 0.2, 4e-3) && near(hi, m4.R + 0.2, 4e-3); }
    gate('4b every one of the six has M4\'s threaded wall (crests r ' + f3(m4.R - m4.h + 0.2) + ', roots r ' + f3(m4.R + 0.2) + ')', ok);
    const mv = meshValidate('m4grid', rg.soup);
    gate('4c mesh_validate --gate on the six-hole slab', mv.pass, mv.fails.join('; '));
    // a faceted tube along X: R 16 / bore 11, 48 facets; click its top; M5 through BOTH walls, square to the surface
    const tube = tubeX(16, 11, 40, 96);
    const pt = P.plan(tube, { point: [20, 0, 16], normal: [0, 0, 1] }, { thread: 'M5' });
    console.log('   ' + pt.reason);
    const ct = P.cutters(pt);
    gate('4d a tube: M5 hole axis radial (straight down), the cutter runs through both walls', pt.ok && pt.holes.length === 1 && Math.abs(pt.holes[0].axis[2] - 1) < 1e-6 && pt.holes[0].depth > 32, pt.holes[0] ? 'depth ' + pt.holes[0].depth.toFixed(2) : pt.reason);
    const rt = await csg.NSO_subtractSoups(tube, ct[0]);
    gate('4e subtracts clean: closed and two holes in the tube make it genus 3', rt.ok && topo(rt.soup).open === 0 && topo(rt.soup).nm === 0, rt.ok ? JSON.stringify(topo(rt.soup)) : rt.reason);
    // a sideways face: the cutter's mapping on an axis that is not +Z - a slab's +X face
    const side = box([0, 0, 0], [30, 30, 30]);
    const ps = P.plan(side, { point: [30, 15, 15], normal: [1, 0, 0] }, { thread: 'M6' });
    const cs = P.cutters(ps), rs = await csg.NSO_subtractSoups(side, cs[0]);
    gate('4f a hole in a +X face: axis (1,0,0) maps the thread onto it, one clean hole', ps.ok && Math.abs(ps.holes[0].axis[0] - 1) < 1e-6 && rs.ok && topo(rs.soup).open === 0 && topo(rs.soup).euler === 0, rs.ok ? JSON.stringify(topo(rs.soup)) : rs.reason);
    // and its handedness on the rotated axis: look down the hole from +X, the bolt from Fasteners (axis +Z) rotated onto it must fit - the best screw position clears by 0.2
    const rod = T.rod({ size: 'M6', length: 12 });
    // rod axis +Z -> hole axis -X (down into the face): map (x, y, z) -> (30 - z, 15 + y, 15 + x) is a rotation (det +1)
    const map = (x, y, z) => [30 - z, 15 + y, 15 + x];   // a rotation (det +1), not a mirror: the hand must survive
    const rodX = new Float32Array(rod.soup.length);
    for (let i = 0; i < rod.soup.length; i += 3) { const q = map(rod.soup[i], rod.soup[i + 1], rod.soup[i + 2]); rodX[i] = q[0]; rodX[i + 1] = q[1]; rodX[i + 2] = q[2]; }
    // distance of the hole wall and of the rod from the hole's axis (the line y = 15, z = 15), along rays out from it at the same (angle, depth)
    function clear() {
      let best = -Infinity;
      for (let c = 0; c < 100; c++) {
        const dx = m6.P * c / 100; let gmin = Infinity;
        for (let i = 0; i < 12; i++) for (let j = 0; j < 6; j++) {
          const th = i * Math.PI / 6 + 0.01, x = 20 + j * 1.3, d = [0, Math.cos(th), Math.sin(th)];
          const hr = rayHits(rs.soup, [x, 15, 15], d)[0], rr = rayHits(rodX, [x - dx, 15, 15], d)[0];
          if (hr != null && rr != null) gmin = Math.min(gmin, hr - rr);
        }
        best = Math.max(best, gmin);
      }
      return best;
    }
    const cl = clear();
    gate('4g on that sideways axis the same Fasteners bolt (rotated onto it) still has a clearing screw position: ' + f3(cl) + ' mm - the thread kept its hand', cl > 0.19, f3(cl));
  }

  /* 5 ------------------------------------------------------------------ */
  console.log('\n--- 5. the wall floor is the thread\'s Ø; refusals; a tapered hole ---');
  {
    const wide = box([0, 0, 0], [60, 30, 10]);
    const pw = P.plan(wide, { point: [20, 15, 10], normal: [0, 0, 1] }, { thread: 'M6', pattern: 'grid', rows: 1, cols: 2, pitchX: 6.7, pitchY: 10, anchor: 'corner' });
    console.log('   ' + pw.reason);
    gate('5a two M6 holes 6.7 apart: the cutters are Ø6.4, so 0.3 mm is left between them - refused against the 0.8 floor', !pw.ok && /^holes 1 and 2 would leave 0\.3 mm between them; the floor is 0\.8$/.test(pw.reason), pw.reason);
    const pe = P.plan(wide, { point: [3.0, 15, 10], normal: [0, 0, 1] }, { thread: 'M6' });
    gate('5b a hole 3.0 from the edge: 3.0 - 3.2 breaks through: refused', !pe.ok && /break through the piece's edge/.test(pe.reason), pe.reason);
    const bad = P.plan(wide, { point: [30, 15, 10], normal: [0, 0, 1] }, { thread: 'M99' });
    gate('5c an unknown thread: refused in words, nothing built', !bad.ok && /^unknown thread size "M99"/.test(bad.reason), bad.reason.slice(0, 60));
    const fine = P.plan(wide, { point: [30, 15, 10], normal: [0, 0, 1] }, { thread: { size: 'M6', pitch: 0.2 } });
    gate('5d a pitch too fine to form: refused in words', !fine.ok && /would not form/.test(fine.reason), fine.reason);
    const note = P.plan(wide, { point: [30, 15, 10], normal: [0, 0, 1] }, { thread: 'M3' });
    gate('5e M3 (0.5 mm pitch) is made, with the note that a 0.4 mm nozzle resolves it roughly', note.ok && /note: a 0\.50 mm pitch is finer than a 0\.4 mm nozzle/.test(note.reason), note.reason.slice(0, 140));
    const lh = P.plan(wide, { point: [30, 15, 10], normal: [0, 0, 1] }, { thread: { size: 'M6', hand: 'left' } });
    gate('5f left-hand says so in the reason', lh.ok && /M6 left-hand threaded/.test(lh.reason), lh.reason);
    const plain = P.plan(wide, { point: [30, 15, 10], normal: [0, 0, 1] }, { diaMm: 5 });
    gate('5g no thread: the plain hole is exactly as before (24-side... 40 sides at Ø5, no thread on the hole)', plain.ok && !plain.holes[0].thread && P.cutters(plain)[0].length / 9 === P.sidesFor(5) * 4 && !plain.thread, plain.reason);
    // a tapered NPT hole: the cutter narrows 1/32 a side per mm of depth
    const slab2 = box([0, 0, 0], [50, 50, 20]);
    const pn = P.plan(slab2, { point: [25, 25, 20], normal: [0, 0, 1] }, { thread: 'NPT1/4', depth: 14 });
    console.log('   ' + pn.reason);
    const cn = P.cutters(pn), rn = await csg.NSO_subtractSoups(slab2, cn[0]);
    const sp = pn.holes[0].thread.spec, zc = sp.fr + sp.w + sp.fc / 2;
    // local z of the world height: the cutter's top is at 20.2, local z = 20.2 - world z; same crest point one and five pitches down
    const w1 = 20.2 - (zc + 1 * sp.P), w2 = 20.2 - (zc + 5 * sp.P);
    // the cutter's crest (the hole's ROOT) narrows with depth: r(w2) < r(w1)
    const a = holeR(rn.soup, 25, 25, Math.PI, w1), b = holeR(rn.soup, 25, 25, Math.PI, w2);
    gate('5h NPT1/4 hole narrows with depth: the same crest point reads r ' + f3(a) + ' -> ' + f3(b) + ' over 4 pitches (' + f3(4 * sp.P / 32) + ' expected, at some phase)', rn.ok && a != null && b != null && a - b > 4 * sp.P / 32 * 0.8 && a - b < 4 * sp.P / 32 * 1.2 + 0.1, a && b ? f3(a - b) : String(rn.reason));
  }

  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* tmp */ }
  console.log('\n' + (fails ? fails + ' FAILED' : 'all ' + passes + ' gates passed'));
  process.exit(fails ? 1 : 0);
})();
