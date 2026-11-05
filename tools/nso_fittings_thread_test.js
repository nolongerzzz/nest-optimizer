#!/usr/bin/env node
// Headless self-test for the THREADED ends of Fittings (nso_fittings.js: splitter trunk / branch ends, threadEndFromTube).
// docs/THREADS.md, docs/FITTINGS.md.
//
//   node tools/nso_fittings_thread_test.js        exit 0 = every gate held
//
// The splitter runs on the app's own kernel (nso_csg.js, Manifold, via tools/nso_csg_node.js). Every number is measured on the
// OUTPUT soup by rays out from a run's axis (the first hit is its bore, the second its thread), and topology by an exact-bit edge
// counter + the genus gate (a thickened sphere with n openings: Euler 4 - 2 n) + tools/mesh_validate.py --gate.
//
//   1. a splitter with a MALE trunk, MALE branches, FEMALE ends, and a mixed one: one body, genus openings - 1, Euler, the thread's
//      crests / roots / pitch measured on the spigot or socket, the male trunk standing on z = 0
//   2. the refusals, in words, before the kernel is asked for anything
//   3. threadEndFromTube: a sleeve read off a stock tube, male and female, and its refusals

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const { writeSTL } = require('./nso_stl_io.js');
const { csgContext } = require('./nso_csg_node.js');
for (const f of ['NSO_Repair.js', 'nso_thickness.js', 'nso_stock.js', 'nso_section.js', 'nso_bend.js', 'nso_tube_edge.js', 'nso_thread.js', 'nso_fittings.js']) {
  vm.runInThisContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), { filename: f });
}
const F = globalThis.NSO_Fittings, S = globalThis.NSO_Stock, T = globalThis.NSO_Thread;

let pass = 0, fail = 0;
const FAILS = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok    ' + name + (detail ? '   ' + detail : '')); }
  else { fail++; FAILS.push(name); console.log('  FAIL  ' + name + (detail ? '   ' + detail : '')); }
}
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nso-fthread-'));
const f3 = x => (+x).toFixed(3);
const near = (a, b, t) => Math.abs(a - b) <= t;

function topo(s) {
  const key = i => s[i] + ',' + s[i + 1] + ',' + s[i + 2];
  const ids = new Map(), vid = [];
  for (let i = 0; i < s.length; i += 3) { const k = key(i); if (!ids.has(k)) ids.set(k, ids.size); vid.push(ids.get(k)); }
  const E = new Map();
  let degen = 0;
  for (let t = 0; t < vid.length / 3; t++) {
    const a = vid[t * 3], b = vid[t * 3 + 1], c = vid[t * 3 + 2];
    if (a === b || b === c || a === c) degen++;
    for (const [p, q] of [[a, b], [b, c], [c, a]]) { const k = Math.min(p, q) + ':' + Math.max(p, q), e = E.get(k) || { n: 0, f: 0 }; e.n++; if (p < q) e.f++; E.set(k, e); }
  }
  let open = 0, nm = 0, flip = 0;
  E.forEach(e => { if (e.n === 1) open++; else if (e.n > 2) nm++; else if (e.f !== 1) flip++; });
  return { tris: vid.length / 3, open, nm, flip, degen, euler: ids.size - E.size + vid.length / 3 };
}
function volume(s) {
  let v = 0;
  for (let o = 0; o < s.length; o += 9) v += s[o] * (s[o + 4] * s[o + 8] - s[o + 5] * s[o + 7]) - s[o + 1] * (s[o + 3] * s[o + 8] - s[o + 5] * s[o + 6]) + s[o + 2] * (s[o + 3] * s[o + 7] - s[o + 4] * s[o + 6]);
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
function bbox(s) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < s.length; i += 3) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], s[i + k]); hi[k] = Math.max(hi[k], s[i + k]); }
  return { lo, hi };
}
function meshValidate(name, soup) {
  const file = path.join(TMP, name + '.stl');
  writeSTL(file, soup);
  let out;
  try { out = execFileSync('python3', [path.join(ROOT, 'tools', 'mesh_validate.py'), file, '--json', '--gate'], { encoding: 'utf8', maxBuffer: 64 << 20 }); } catch (e) { out = e.stdout; }
  try { const j = JSON.parse(out); return { pass: j.verdict === 'PASS', fails: j.verdict_fails || [] }; } catch (e) { return { pass: false, fails: ['no JSON'] }; }
}
function closed(tag, soup, euler) {
  const T0 = topo(soup);
  check(tag + ': closed, 2-manifold, consistently wound, no zero-area faces, Euler ' + euler,
    T0.open === 0 && T0.nm === 0 && T0.flip === 0 && T0.degen === 0 && T0.euler === euler, `${T0.tris} tris, open ${T0.open} nm ${T0.nm} flip ${T0.flip} degen ${T0.degen} euler ${T0.euler}`);
  const MV = meshValidate(tag.replace(/[^a-z0-9]+/gi, '_'), soup);
  check(tag + ': mesh_validate --gate PASS', MV.pass, MV.pass ? '' : MV.fails.join('; '));
  check(tag + ': wound outward (volume > 0)', volume(soup) > 0, f3(volume(soup)) + ' mm³');
}
// the thread's radius extremes (crest, root) along a run, measured by rays across its axis: rays from axis point c, direction d (unit,
// square to the axis), sampled over `span` mm along `axis`; `nth` the hit to read (0 first = the bore of a socket; 1 the second = a spigot's thread)
function profile(soup, c, axis, d, z0, span, nth, steps) {
  let lo = Infinity, hi = 0;
  for (let k = 0; k < steps; k++) {
    const z = z0 + span * k / steps, o = [c[0] + axis[0] * z, c[1] + axis[1] * z, c[2] + axis[2] * z], h = rayHits(soup, o, d);
    if (h.length > nth) { lo = Math.min(lo, h[nth]); hi = Math.max(hi, h[nth]); }
  }
  return { lo, hi };
}
const stockTube = (rOut, wall, h) => S.revolve(S.profileTube(rOut, rOut - wall, h), 96);

(async () => {
  const ctx = csgContext(), wasm = await ctx.NSO_CSG.load(), helpers = { soupToManifold: ctx.NSO_CSG.soupToManifold };
  const split = (o) => F.splitter(o, wasm, helpers);
  const g34 = T.spec('G3/4').spec, g12 = T.spec('G1/2').spec;
  const branchAxis = (angle, az) => { const t = angle * Math.PI / 180, a = az * Math.PI / 180; return [Math.sin(t) * Math.cos(a), Math.sin(t) * Math.sin(a), Math.cos(t)]; };

  console.log('\n=== 1. a MALE trunk: a threaded spigot under the inlet ===');
  {
    const o = { ways: 2, od: 28, wall: 3, branchOd: 28, trunkEnd: 'male', trunkThread: 'G3/4' };
    const r = await split(o);
    console.log('   ' + r.reason);
    check('2-way, Ø28 / wall 3 trunk, male G3/4: made, one body of genus 2', r.ok && r.info.genus === 2, r.reason);
    const I = r.info, s = r.soup;
    closed('2-way male-trunk splitter', s, -2);
    const bb = bbox(s);
    check('the spigot stands on the bed: lowest point z = 0 (the piece was lifted by the spigot\'s ' + I.trunkEnd.lenMm + ' mm)', near(bb.lo[2], 0, 1e-4), f3(bb.lo[2]));
    const Lt = I.trunkEnd.lenMm;
    const pr = profile(s, [0, 0, 0], [0, 0, 1], [0, 1, 0], 1, Lt - 2, 1, 160);
    check('the spigot\'s thread: crests r ' + f3(pr.hi) + ' = ' + f3(g34.R) + ' (G3/4 Ø26.441), roots r ' + f3(pr.lo) + ' = ' + f3(g34.R - g34.h), near(pr.hi, g34.R, 6e-3) && near(pr.lo, g34.R - g34.h, 6e-3));
    // its bore: the first hit is the spigot's bore (thread root - wall, or the run's, whichever is less)
    const b0 = rayHits(s, [0, 0, 3], [0, 1, 0])[0], wantBore = Math.min(28 / 2 - 3, g34.minor / 2 - 3);
    check('its bore is the run\'s, held under the root less the wall: r ' + f3(b0) + ' = ' + f3(wantBore), near(b0, wantBore, 8e-3));
    // pitch along z at one angle
    const mid = g34.R - g34.h / 2, rise = (z0) => { let prev = null; for (let i = 0; i <= 900; i++) { const z = z0 + g34.P * 1.3 * i / 900, h = rayHits(s, [0, 0, z], [0, 1, 0]), r = h[1]; if (prev != null && prev < mid && r >= mid) return z; prev = r; } return null; };
    const z1 = rise(1), z2 = rise(z1 + 0.4);
    check('the spigot\'s pitch along z is ' + f3(z2 - z1) + ' = ' + f3(g34.P), near(z2 - z1, g34.P, 8e-3));
    check('the run above it keeps its Ø28 outside and Ø22 bore (a ray across the trunk\'s middle, z ' + (Lt + 12) + ')', (() => { const h = rayHits(s, [0, 0, Lt + 10], [0, 1, 0]); return near(h[0], 11, 8e-3) && near(h[1], 14, 8e-3); })());
  }

  console.log('\n=== 2. MALE branches, and a 3-way with male at every end ===');
  {
    const r = await split({ ways: 2, od: 28, wall: 3, branchOd: 28, branchLen: 40, branchEnd: 'male', branchThread: 'G3/4' });
    console.log('   ' + r.reason);
    check('2-way, male G3/4 branch ends: made, genus 2', r.ok && r.info.genus === 2, r.reason);
    closed('2-way male-branches splitter', r.soup, -2);
    const I = r.info, Lt = I.branchEnd.lenMm, ax = branchAxis(35, 0), J = 25, Lb = 40;
    // along the branch at azimuth 0: the axis point at distance d from the junction; rays across it along +y (square to the axis)
    const c = [0, 0, J], pr = profile(r.soup, c, ax, [0, 1, 0], Lb + 1, Lt - 2, 1, 160);
    check('a branch spigot\'s thread: crests r ' + f3(pr.hi) + ' = ' + f3(g34.R) + ', roots ' + f3(pr.lo) + ' = ' + f3(g34.R - g34.h) + ' (measured square to the tilted axis)', near(pr.hi, g34.R, 6e-3) && near(pr.lo, g34.R - g34.h, 6e-3));
    const e = ax.map(x => x * (Lb + Lt)), tip = [e[0], 0, J + e[2]];
    check('its free end is where the geometry puts it: ' + (Lb + Lt) + ' mm out along the 35° axis (the box reaches x ' + f3(bbox(r.soup).hi[0]) + ' ≥ ' + f3(tip[0]) + ')', bbox(r.soup).hi[0] >= tip[0] - 1e-3);
  }
  {
    const r = await split({ ways: 3, od: 28, wall: 3, branchOd: 28, branchLen: 50, angle: 55, trunkEnd: 'male', trunkThread: 'G3/4', branchEnd: 'male', branchThread: 'G3/4' });
    console.log('   ' + r.reason);
    check('3-way, male at all four ends: one body, genus 3', r.ok && r.info.genus === 3, r.reason);
    closed('3-way all-male splitter', r.soup, -4);
    check('the status carries both ends', /trunk male G3\/4 thread \(11\.0 mm, a spigot\).* branch ends male G3\/4 thread/.test(r.reason), r.reason);
  }

  console.log('\n=== 3. FEMALE ends: sockets cut into the runs (a boss where the run is thin) ===');
  {
    const o = { ways: 3, od: 26, wall: 2.4, branchOd: 24, branchLen: 60, angle: 50, trunkEnd: 'female', trunkThread: 'G1/2', branchEnd: 'female', branchThread: 'G1/2' };
    const r = await split(o);
    console.log('   ' + r.reason);
    check('3-way, G1/2 sockets at all four ends: made, one body, genus 3', r.ok && r.info.genus === 3, r.reason);
    closed('3-way all-female splitter', r.soup, -4);
    const s = r.soup, Lt = r.info.trunkEnd.lenMm, fit = T.DEFAULTS.fit;
    const pr = profile(s, [0, 0, 0], [0, 0, 1], [0, 1, 0], 1, Lt - 2, 0, 160);
    check('the trunk\'s socket thread: first hit from the axis runs r ' + f3(pr.lo) + ' to ' + f3(pr.hi) + ' (the thread + 0.2: ' + f3(g12.R - g12.h + fit) + ' to ' + f3(g12.R + fit) + ')', near(pr.lo, g12.R - g12.h + fit, 6e-3) && near(pr.hi, g12.R + fit, 6e-3));
    const ax = branchAxis(50, 0), pb = profile(s, [0, 0, 25], ax, [0, 1, 0], 60 - Lt + 1, Lt - 2, 0, 160);
    check('a branch socket: r ' + f3(pb.lo) + ' to ' + f3(pb.hi) + ' (same)', near(pb.lo, g12.R - g12.h + fit, 6e-3) && near(pb.hi, g12.R + fit, 6e-3));
    check('the piece\'s lowest point is z = 0 (a female trunk is cut into the run, nothing hangs below)', near(bbox(s).lo[2], 0, 1e-4), f3(bbox(s).lo[2]));
    // the boss: the run is Ø26 outside; the socket's outside is G1/2 + fit + wall = Ø20.955 + 0.4 + 4.8 = 26.155 > 26 -> a boss of r 13.0775
    const bossR = g12.R + fit + 2.4, h = rayHits(s, [0, 0, 5], [0, 1, 0]);
    check('where the run is thinner than the socket needs a boss: the trunk\'s outside there is r ' + f3(h[h.length - 1]) + ' = ' + f3(bossR) + ' (Ø26 run + boss)', near(h[h.length - 1], Math.max(13, bossR), 8e-3));
  }
  {
    // a socket with a FLOOR: the flow bore (Ø16) is narrower than the thread's crests, so the socket ends in a ledge at z = len
    const r = await split({ ways: 2, od: 24, wall: 4, branchOd: 18, trunkLen: 30, trunkEnd: 'female', trunkThread: 'G1/2' });
    console.log('   ' + r.reason);
    check('2-way, Ø24 / wall 4 trunk, G1/2 socket: made, genus 2', r.ok && r.info.genus === 2, r.reason);
    if (r.ok) {
      closed('2-way floored-socket splitter', r.soup, -2);
      const Lt = r.info.trunkEnd.lenMm, up = rayHits(r.soup, [9, 0, -3], [0, 0, 1]).map(d => d - 3);
      check('the socket ends in a floor at z = ' + f3(Lt) + ' (a ray up at r 9, inside the thread\'s roots but outside the Ø16 flow bore, first meets it at ' + f3(up[0]) + ')', near(up[0], Lt, 2e-3), up.slice(0, 2).map(f3).join(' / '));
      const flow = rayHits(r.soup, [0, 0, Lt + 3], [0, 1, 0])[0];
      check('above the floor the flow bore is the run\'s: r ' + f3(flow) + ' = 8', near(flow, 8, 8e-3));
    }
  }
  {
    // a socket wider than the run itself (G3/4's crests r 13.4 on a Ø21 branch): the cut takes the branch's wall away, so the boss has to
    // hold on BELOW the socket's floor. Found by the card's drive check: it built 31 bodies before the shoulder.
    const r = await split({ ways: 2, od: 28, wall: 3, branchOd: 21, branchLen: 60, angle: 50, branchEnd: 'female', branchThread: 'G3/4' });
    console.log('   ' + r.reason);
    check('2-way, Ø21 branches with G3/4 sockets (wider than the branch): made, ONE body, genus 2', r.ok && r.info.genus === 2, r.reason);
    if (r.ok) closed('2-way wide-socket splitter', r.soup, -2);
    const z = F.splitterSize({ ways: 2, od: 28, wall: 3, branchOd: 21, branchLen: 20, angle: 50, branchEnd: 'female', branchThread: 'G3/4' });
    console.log('   ' + z.reason);
    check('a branch too short for the socket and its 2 mm shoulder is refused in words, with the length that works', !z.ok && /^the branches are 20\.0 mm long - too short for a 11\.0 mm G3\/4 socket \(and its 2 mm shoulder\) that must stop short of the hub; make them at least 27\.0 mm$/.test(z.reason), z.reason);
  }
  {
    const r = await split({ ways: 2, od: 20, wall: 2.4, branchOd: 14, branchLen: 45, angle: 40, trunkEnd: 'female', trunkThread: 'G1/4', branchEnd: 'male', branchThread: 'G1/4' });
    console.log('   ' + r.reason);
    check('a mixed one: female G1/4 trunk, male G1/4 branches: made, genus 2', r.ok && r.info.genus === 2, r.reason);
    if (r.ok) closed('2-way mixed splitter', r.soup, -2);
  }
  {
    const r = await split({ ways: 2, od: 30, wall: 3.2, branchOd: 30, trunkLen: 30, branchLen: 55, angle: 40, trunkEnd: 'female', trunkThread: 'NPT1/2', branchEnd: 'female', branchThread: 'NPT1/2' });
    console.log('   ' + r.reason);
    check('NPT1/2 sockets (tapered 1:16): made, genus 2', r.ok && r.info.genus === 2, r.reason);
    if (r.ok) {
      closed('2-way NPT socket splitter', r.soup, -2);
      const sp = T.spec('NPT1/2').spec, zc = sp.fr + sp.w + sp.fc / 2, Lt = r.info.trunkEnd.lenMm;
      // the socket's mouth at z = 0 is the wider end: the root of the cut (its bore's largest) narrows 1/32 a side per mm toward the floor
      const a = rayHits(r.soup, [0, 0, zc + 1 * sp.P], [0, 1, 0])[0], b = rayHits(r.soup, [0, 0, zc + 4 * sp.P], [0, 1, 0])[0];
      check('the trunk socket narrows toward its floor: ' + f3(a) + ' -> ' + f3(b) + ' over 3 pitches (' + f3(3 * sp.P / 32) + ')', near(a - b, 3 * sp.P / 32, 6e-3), f3(a - b));
    }
  }

  console.log('\n=== 4. refusals, in words, before the kernel is asked ===');
  {
    const no = async (tag, o, re) => { const r = await split(o); console.log('   ' + r.reason); check('refused: ' + tag, !r.ok && !r.soup && re.test(r.reason), r.reason); };
    await no('a male thread wider than the run it goes on', { ways: 2, trunkEnd: 'male', trunkThread: 'G3/4' },
      /^the G3\/4 male thread is Ø26\.44 across - wider than the trunk's Ø20\.00 outside; make it at least Ø26\.9 or take a smaller thread$/);
    await no('a male spigot that does not reach the wall', { ways: 2, od: 26, wall: 2.4, branchOd: 24, trunkEnd: 'male', trunkThread: 'G1/2' },
      /^the G1\/2 male thread's root \(Ø18\.63\) is inside the trunk's bore \(Ø21\.20\) - it would not join the wall; a bite of 0\.80 mm needs a bore under Ø17\.03/);
    await no('a socket longer than the run leaves room for', { ways: 2, od: 28, wall: 3, branchOd: 28, trunkEnd: 'female', trunkThread: 'G1/2', trunkLen: 20 },
      /^the trunk is 20\.0 mm long - too short for a 11\.0 mm G1\/2 socket that must stop short of the hub; make it at least 25\.0 mm$/);
    await no('sockets that touch where they begin', { ways: 3, od: 24, wall: 2.4, branchOd: 20, branchLen: 30, angle: 20, branchEnd: 'female', branchThread: 'G1/2' },
      /^the 3 G1\/2 sockets would (run into each other|stand only [0-9.]+ mm apart) where they begin|^the 3 outlets would/);
    await no('an unknown thread', { ways: 2, trunkEnd: 'male', trunkThread: 'G9' }, /^trunk thread: unknown thread size "G9"/);
    await no('a thread too short', { ways: 2, od: 28, wall: 3, branchOd: 28, trunkEnd: 'male', trunkThread: 'G3/4', threadLen: 3 }, /^a thread length of 3\.0 mm is under two pitches of G3\/4/);
    await no('an end that is not an end', { ways: 2, trunkEnd: 'banjo' }, /^the trunk end is plain, male or female$/);
    check('plain ends (the default) are exactly as before: no threadEnds in the numbers', (() => { const z = F.splitterSize({ ways: 2 }); return z.ok && !z.p.trunkEnd && !z.p.branchEnd; })());
  }

  console.log('\n=== 5. the threaded end for a tube: a sleeve read off the tube ===');
  {
    const tube = stockTube(10, 1.6, 40);
    for (const end of ['male', 'female']) {
      const r = F.threadEndFromTube(tube, { end, size: 'G1/2' });
      console.log('   ' + r.reason);
      check(end + ' end for the Ø20 / 1.6 stock tube: made, read off the tube (Ø' + f3(r.ok ? r.info.tubeOdMm : 0) + ', wall ' + f3(r.ok ? r.info.tubeWallMm : 0) + ')', r.ok && near(r.info.tubeOdMm, 20, 2e-3) && near(r.info.tubeWallMm, 1.6, 2e-3), r.reason);
      if (!r.ok) continue;
      closed(end + ' threaded end', r.soup, 0);
      const I = r.info, flat = Math.PI / 96;
      const h = rayHits(r.soup, [0, 0, I.depthMm / 2], [Math.cos(flat), Math.sin(flat), 0]);
      check(end + ' end: the socket\'s bore is the tube\'s Ø20 + 2 x 0.25 = 20.5 (flats r ' + f3(h[0]) + ') and its wall the tube\'s 1.6', near(h[0], 10.25, 2e-3) && near(h[1] - h[0], 1.6, 2e-3), h.slice(0, 2).map(f3).join(' / '));
      const tubeLen = 40, tubeStop = rayHits(r.soup, [I.boreMm / 2 + 0.3, 0, -2], [0, 0, 1]).map(d => d - 2);
      check(end + ' end: a ledge stops the tube at z = ' + f3(I.depthMm) + ' (a ray up the flow bore\'s wall, ' + tubeStop.slice(0, 2).map(f3).join(' / ') + ')', tubeStop.some(d => near(d, I.depthMm, 1e-4)));
      check(end + ' end: the thread end is open through (axis ray meets nothing), tube end down on z = 0', rayHits(r.soup, [0, 0, -3], [0, 0, 1]).length === 0 && near(bbox(r.soup).lo[2], 0, 1e-5));
    }
    const rb = F.threadEndFromTube(tube, { point: [0, 8, 0.5], end: 'male', size: 'G1/2' });
    check('the tube\'s other end read the same: the same sleeve', rb.ok && near(rb.info.tubeOdMm, 20, 2e-3));
    const no = (tag, r, re) => { console.log('   ' + r.reason); check('refused: ' + tag, !r.ok && !r.soup && re.test(r.reason), r.reason); };
    no('a closed piece - the reader\'s words, with the threaded end\'s tail', F.threadEndFromTube(S.boxSoup(30, 20, 10), { size: 'G1/2' }), /A threaded end fits the open, round end of a tube\.$/);
    const flared = globalThis.NSO_tubeEdgeRaw(stockTube(10, 1.6, 40), { verb: 'flare', length: 8, angle: 30 });
    no('a flared end', F.threadEndFromTube(flared.tris, { size: 'G1/2' }), /^that tube's wall leans 30\.0° off its axis at the end \(a flare or a taper\) - a sleeve slips over a straight pipe, within 2°$/);
    no('a negative gap', F.threadEndFromTube(tube, { size: 'G1/2', gap: -0.2 }), /^a fit gap of -0\.20 mm is refused/);
    no('a bore too wide for the thread root', F.threadEndFromTube(tube, { size: 'G1/2', bore: 17 }), /under the G1\/2 thread's root/);
    no('a thread too small for this tube', F.threadEndFromTube(tube, { size: 'M3' }), /^the flow bore would be Ø/);
    const cap = F.capFromTube(tube, {});
    check('capFromTube is as it was after sharing the tube reader', cap.ok && near(cap.info.tubeOdMm, 20, 2e-3) && near(cap.info.wallMm, 1.6, 2e-3));
  }

  console.log('\n' + (fail ? fail + ' FAILED: ' + FAILS.join('; ') : 'all ' + pass + ' checks passed'));
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* tmp */ }
  process.exit(fail ? 1 : 0);
})();
