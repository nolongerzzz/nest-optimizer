#!/usr/bin/env node
/* Limb, headless: grab a branch anywhere, stretch it, bend it.
     node tools/nso_limb_test.js            exit 0 = every gate held
     npm run limb:test

   The pointer session is proven in tools/nso_limb_drive_check.js; this is the
   geometry, on its own, with no browser. The piece is fixtures/tree_sample.stl:
   a 71 mm tree, 3,796 triangles, one closed surface (V - E + F = 2), whose trunk
   leans 3.25 degrees off Z - the piece Extend refuses ("dominant axis is
   off-cardinal"). Every output that is meant to be a good mesh goes through the
   canonical checker, tools/mesh_validate.py --gate, as a real STL on disk.

   Sections
     1  the tree          the root, the distance from it, a tip's limb, a mid-limb
                          grab, a trunk grab, a thick stub: each one found
     2  Extend            a tip's centre lands exactly where it was sent; every
                          ring slides, none changes shape; nothing outside the
                          limb moves a bit; the result is a clean mesh
     3  Bend              the carried part is rigid; the hinge end is exactly
                          where it was; 90 degrees on a 15 mm twig is clean
     4  follow the cursor free: the centre lands on the target; bend: the length
                          is held; extend: the turn is zero
     5  reach             a hinge nearer the grab leaves the rest of the limb alone
     6  limits + guards   the turn is capped by the limb's own width; a bend
                          through the trunk is refused in words, piece unchanged
*/

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const L = require('../nso_limb.js');
const D = require('../nso_densify.js');
const REPAIR = require('../NSO_Repair.js').NSO_Repair;
const { readSTL, writeSTL } = require('./nso_stl_io.js');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nso-limb-'));
const MV = path.join(ROOT, 'tools', 'mesh_validate.py');

let pass = 0, fail = 0;
const FAILS = [];
function ok(cond, label, detail) {
  if (cond) { pass++; console.log('  ok    ' + label + (detail ? '   ' + detail : '')); }
  else { fail++; FAILS.push(label); console.log('  FAIL  ' + label + (detail ? '\n          ' + detail : '')); }
}
const f3 = v => (Math.round(v * 1000) / 1000).toString();
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const vpos = (pos, v) => [pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]];

function canonical(soup, tag) {
  const p = path.join(TMP, tag + '.stl');
  writeSTL(p, soup, 'nso limb ' + tag);
  let out;
  try { out = execFileSync('python3', [MV, p, '--json', '--gate'], { maxBuffer: 1 << 28 }); }
  catch (e) { out = e.stdout; }
  return JSON.parse(out.toString());
}

/* Open / non-manifold edges and Euler's number of a soup. */
function topology(soup) {
  const m = D.weld(soup), und = new Map();
  for (let t = 0; t < m.triCount; t++) {
    for (let e = 0; e < 3; e++) {
      const u = m.tri[t * 3 + e], v = m.tri[t * 3 + (e + 1) % 3];
      const k = u < v ? u + '_' + v : v + '_' + u;
      und.set(k, (und.get(k) || 0) + 1);
    }
  }
  let open = 0, nm = 0;
  und.forEach(c => { if (c === 1) open++; else if (c > 2) nm++; });
  return { open, nm, euler: m.vertCount - und.size + m.triCount };
}

const soup = readSTL(path.join(ROOT, 'fixtures', 'tree_sample.stl'));

/* ---------------------------------------------------------------- 1. the tree */
console.log('== 1. the tree');
const ctx = L.context(soup);
ok(ctx.ok, 'the tree is one connected surface, welded to ' + (ctx.mesh && ctx.mesh.vertCount) + ' vertices');
const mesh = ctx.mesh, dd = ctx.d, g = ctx.graph;
let zlo = Infinity, zhi = -Infinity;
for (let v = 0; v < mesh.vertCount; v++) { zlo = Math.min(zlo, mesh.pos[v * 3 + 2]); zhi = Math.max(zhi, mesh.pos[v * 3 + 2]); }
ok(ctx.roots.every(v => mesh.pos[v * 3 + 2] <= zlo + 0.03 * (zhi - zlo) + 1e-9) && ctx.roots.length > 0,
   'the root is the foot of the trunk (' + ctx.roots.length + ' vertices in the lowest 3% of the height)');
ok(Math.min.apply(null, Array.from(dd)) === 0, 'distance from the root starts at 0 and reaches ' + f3(Math.max.apply(null, Array.from(dd))) + ' mm');

const tips = [];
for (let v = 0; v < mesh.vertCount; v++) {
  let mx = true;
  for (let j = g.start[v]; j < g.start[v + 1]; j++) if (dd[g.list[j]] > dd[v]) { mx = false; break; }
  if (mx) tips.push(v);
}
ok(tips.length >= 20, tips.length + ' local ends on the tree');
let probed = 0, longest = 0;
for (const tp of tips) {
  const p = L.probe(ctx, vpos(mesh.pos, tp));
  if (p.ok && p.L > 0) probed++;
  if (p.ok && p.L > longest) longest = p.L;
}
ok(probed === tips.length, 'every one of them resolves to a limb with a fork below it (' + probed + ' of ' + tips.length + ')');

const TIP = 335;                                    // a prong on the upper left; its fork is 15 mm below
const tipC = vpos(mesh.pos, TIP);
const pTip = L.probe(ctx, tipC);
ok(pTip.ok && !pTip.atBase && pTip.nCarried === 1 && pTip.L > 10 && pTip.L < 20,
   'a tip: one carried vertex, a ' + f3(pTip.L) + ' mm limb down to its fork, ring radius ' + f3(pTip.radius) + ' mm');
let midV = -1, bestD = Infinity;
const midLevel = pTip.tFork + 0.6 * (pTip.dGrab - pTip.tFork);
for (let v = 0; v < mesh.vertCount; v++) if (pTip.limb[v] && Math.abs(dd[v] - midLevel) < bestD) { bestD = Math.abs(dd[v] - midLevel); midV = v; }
const midC = vpos(mesh.pos, midV);
const pMid = L.probe(ctx, midC);
ok(pMid.ok && pMid.nCarried > 5 && pMid.nCarried < pTip.nLimb && Math.abs(pMid.tFork - pTip.tFork) < 1e-9,
   'grabbed two thirds of the way up, the same fork is found and ' + pMid.nCarried + ' vertices ride along');
const trunkV = (() => { let b = -1, bz = Infinity; for (let v = 0; v < mesh.vertCount; v++) { const z = mesh.pos[v * 3 + 2]; if (z > zlo + 8 && z < bz && Math.hypot(mesh.pos[v * 3], mesh.pos[v * 3 + 1]) < 4) { bz = z; b = v; } } return b; })();
const pTrunk = L.probe(ctx, vpos(mesh.pos, trunkV));
ok(pTrunk.ok && pTrunk.nCarried > 0.7 * mesh.vertCount,
   'a grab low on the trunk carries the tree (' + (pTrunk && pTrunk.nCarried) + ' of ' + mesh.vertCount + ' vertices)');
const noise = L.probe(ctx, vpos(mesh.pos, 338));    // the neighbouring local maximum on the same prong's tip
ok(noise.ok && Math.abs(noise.L - pTip.L) < 0.5 && Math.abs(noise.tFork - pTip.tFork) < 0.5,
   'a second local maximum on the same tip is a bump, not a fork: the same limb is found');

/* ---------------------------------------------------------------- 2. Extend */
console.log('\n== 2. Extend');
const S = L.prepare(soup, tipC, { ctx });
ok(S.ok, 'prepared: ' + (S.ok ? L.describe(S) : S.reason));
ok(S.mesh.triCount > 3796, 'the flex zone is densified (' + L.describe(S).split(',')[0] + '; ' + S.densify.trisBefore + ' -> ' + S.mesh.triCount + ' triangles)');
const u0 = S.u0;
const r2 = L.displaceBy(S, 8, 0, null);
const vg = S.an.vg;
const slid = dist(vpos(S.pos, vg), vpos(S.basePos, vg));
ok(Math.abs(slid - 8) < 1e-9 && Math.abs(dot([0, 1, 2].map(k => S.pos[vg * 3 + k] - S.basePos[vg * 3 + k]), u0) - 8) < 1e-9,
   'the tip moved 8.0000 mm, along the limb (' + f3(slid) + ')');
let outsideMoved = 0, inside = 0;
for (let v = 0; v < S.mesh.vertCount; v++) {
  const moved = S.pos[v * 3] !== S.basePos[v * 3] || S.pos[v * 3 + 1] !== S.basePos[v * 3 + 1] || S.pos[v * 3 + 2] !== S.basePos[v * 3 + 2];
  if (S.limb[v]) inside++; else if (moved) outsideMoved++;
}
ok(outsideMoved === 0, 'not one vertex outside the limb moved by a bit (' + (S.mesh.vertCount - inside) + ' vertices held)');
let worstPerp = 0;
for (let i = 0; i < S.touched.length; i++) {
  const v = S.touched[i], dv = [0, 1, 2].map(k => S.pos[v * 3 + k] - S.basePos[v * 3 + k]);
  const along = dot(dv, u0), perp = Math.hypot(dv[0] - along * u0[0], dv[1] - along * u0[1], dv[2] - along * u0[2]);
  if (perp > worstPerp) worstPerp = perp;
}
ok(worstPerp < 1e-9, 'every vertex slid along the limb and no way else: the cross-section is untouched (worst sideways ' + worstPerp.toExponential(1) + ' mm)');
const fin2 = L.finish(S, { repair: REPAIR });
ok(fin2.ok, 'passes its guards', fin2.reason || ('self-intersections ' + fin2.report.pierce.before + ' -> ' + fin2.report.pierce.after));
const topo2 = topology(fin2.tris);
ok(topo2.open === 0 && topo2.nm === 0 && topo2.euler === 2, 'still one closed manifold (open ' + topo2.open + ', non-manifold ' + topo2.nm + ', V-E+F ' + topo2.euler + ')');
const mv2 = canonical(fin2.tris, 'extend-tip');
ok(mv2.verdict === 'PASS', 'mesh_validate.py --gate: ' + mv2.verdict + ', ' + mv2.triangles + ' triangles, volume ' + f3(mv2.signed_volume) + ' (was 5714.634)');
ok(mv2.signed_volume > 5714.634, 'the tree got bigger, by ' + f3(mv2.signed_volume - 5714.634) + ' mm3 (the twig is ~1.5 mm across)');

/* A shorten is the same thing run backwards. */
L.displaceBy(S, -5, 0, null);
const finS = L.finish(S, { repair: REPAIR });
ok(finS.ok && canonical(finS.tris, 'shorten-tip').verdict === 'PASS', 'a shortening of 5 mm is clean too');

/* ---------------------------------------------------------------- 3. Bend */
console.log('\n== 3. Bend');
const Sm = L.prepare(soup, midC, { ctx });
ok(Sm.ok && Sm.an.nCarried > 50, 'mid-limb grab prepared: ' + L.describe(Sm));
function rigidError(S, ids) {
  let worst = 0;
  for (let q = 0; q < 400; q++) {
    const a = ids[(q * 7919) % ids.length], b = ids[(q * 104729 + 13) % ids.length];
    const before = dist(vpos(S.basePos, a), vpos(S.basePos, b)), after = dist(vpos(S.pos, a), vpos(S.pos, b));
    if (Math.abs(before - after) > worst) worst = Math.abs(before - after);
  }
  return worst;
}
const toX = [1, 0, 0];
const r3 = L.displaceBy(Sm, 0, 60, toX);
ok(Math.abs(r3.angleDeg - 60) < 1e-9 && r3.clampedAngle === false, 'a 60 degree bend is taken whole');
// The carried vertices a cut's tilt leaves a little short of the grab follow the
// zone's law (that is what keeps the seam from folding); everything else is rigid.
const rigidIds = [], seamIds = [];
for (let i = 0; i < Sm.touched.length; i++) {
  const v = Sm.touched[i];
  if (Sm.carried[v]) (Sm.rigid[i] ? rigidIds : seamIds).push(v);
}
ok(rigidIds.length > 0.6 * Sm.an.nCarried && rigidError(Sm, rigidIds) < 1e-9,
   'the carried part is one rigid body: ' + rigidIds.length + ' of its ' + Sm.an.nCarried + ' vertices keep every distance to ' + rigidError(Sm, rigidIds).toExponential(1) + ' mm; the other ' + seamIds.length + ' are the seam');
ok(rigidError(Sm, rigidIds.concat(seamIds)) < 0.1, 'and the seam is within ' + f3(rigidError(Sm, rigidIds.concat(seamIds))) + ' mm of rigid');
// the hinge end: every limb vertex at or below the hinge plane is where it was
let hingeMoved = 0, hingeN = 0;
for (let v = 0; v < Sm.mesh.vertCount; v++) {
  if (!Sm.limb[v] || Sm.carried[v]) continue;
  const s = (Sm.basePos[v * 3] - Sm.Q[0]) * Sm.u0[0] + (Sm.basePos[v * 3 + 1] - Sm.Q[1]) * Sm.u0[1] + (Sm.basePos[v * 3 + 2] - Sm.Q[2]) * Sm.u0[2];
  if (s <= 0) { hingeN++; if (dist(vpos(Sm.pos, v), vpos(Sm.basePos, v)) !== 0) hingeMoved++; }
}
ok(hingeMoved === 0, 'the hinge end is exactly where it was (' + hingeN + ' vertices at or below the hinge plane, none moved)');
const fin3 = L.finish(Sm, { repair: REPAIR });
ok(fin3.ok && canonical(fin3.tris, 'bend60').verdict === 'PASS', '60 degrees: passes its guards and mesh_validate.py --gate');
const rTipBend = L.displaceBy(S, 0, 90, toX);
const fin90 = L.finish(S, { repair: REPAIR });
ok(fin90.ok, '90 degrees on a 15 mm twig: no triangle folded, no self-intersection', fin90.reason || '');
const mv90 = canonical(fin90.tris, 'bend90');
ok(mv90.verdict === 'PASS', 'mesh_validate.py --gate: ' + mv90.verdict + '; volume ' + f3(mv90.signed_volume) + ' vs 5714.634 (a bend keeps girth: within 1%)');
ok(Math.abs(mv90.signed_volume - 5714.634) / 5714.634 < 0.01, 'volume change ' + f3(mv90.signed_volume - 5714.634) + ' mm3');
// the ring's own shape: the carried tip is turned by exactly the bend
const tipV0 = vpos(S.basePos, vg), tipV1 = vpos(S.pos, vg);
ok(rTipBend.angleDeg === 90 && dist(rTipBend.A1, tipV1) < 0.35,
   'the tip is where the arc ends (the centre of its ring ' + f3(dist(rTipBend.A1, tipV1)) + ' mm from the tip vertex)');

/* ---------------------------------------------------------------- 4. follow the cursor */
console.log('\n== 4. follow the cursor');
const side = (() => { const p = [1, 0, 0].map((x, i) => x - S.u0[i] * S.u0[0]); const l = Math.hypot(p[0], p[1], p[2]); return p.map(x => x / l); })();
const reachable = [
  ['6 mm sideways', side.map(x => x * 6)],
  ['12 mm sideways', side.map(x => x * 12)],
  ['8 sideways, 5 out', side.map((x, i) => x * 8 + S.u0[i] * 5)],
  ['10 sideways, 6 back', side.map((x, i) => x * 10 - S.u0[i] * 6)],
  ['20 mm straight out', S.u0.map(x => x * 20)],
  ['8 mm back', S.u0.map(x => x * -8)]
];
let worstMiss = 0;
for (const [name, Dv] of reachable) {
  const r = L.displaceTo(S, Dv, 'free');
  const miss = dist(r.A1, S.A.map((a, i) => a + Dv[i]));
  if (miss > worstMiss) worstMiss = miss;
  const fin = L.finish(S, { repair: REPAIR });
  ok(miss < 1e-5 && fin.ok, 'free: ' + name + ' -> the centre lands on the cursor (miss ' + miss.toExponential(1) + ' mm), turn ' + f3(r.angleDeg) + ' deg, grown ' + f3(r.ext) + ' mm',
     fin.ok ? '' : fin.reason);
}
{
  const r = L.displaceTo(S, side.map(x => x * 12), 'bend');
  ok(r.ext === 0 && r.angleDeg > 30 && r.angleDeg < 110, 'bend: 12 mm sideways turns the limb ' + f3(r.angleDeg) + ' deg and grows it by exactly 0');
  const r2 = L.displaceTo(S, S.u0.map((x, i) => x * 6 + side[i] * 9), 'extend');
  ok(r2.angleDeg === 0 && Math.abs(r2.ext - 6) < 1e-9, 'extend: only the 6 mm along the limb is taken, the 9 mm sideways is not (turn ' + r2.angleDeg + ')');
}
{
  const r = L.displaceTo(S, side.map(x => x * 40), 'free');
  ok(r.clampedAngle === true && r.angleDeg <= L.MAX_BEND_DEG + 1e-9, 'a drag past what a limb can do is cut at ' + f3(r.angleDeg) + ' deg and says so');
}

/* ---------------------------------------------------------------- 5. reach */
console.log('\n== 5. reach');
{
  const Sr = L.prepare(soup, tipC, { ctx, reach: 4 });
  ok(Sr.ok && Math.abs(Sr.reach - 4) < 1e-12 && Sr.reachClipped === false, 'a 4 mm reach: the zone is the last 4 mm of a ' + f3(Sr.L) + ' mm limb');
  L.displaceBy(Sr, 0, 50, toX);
  let held = 0, n = 0;
  for (let v = 0; v < Sr.mesh.vertCount; v++) {
    if (!Sr.limb[v] || Sr.carried[v]) continue;
    const s = (Sr.basePos[v * 3] - Sr.Q[0]) * Sr.u0[0] + (Sr.basePos[v * 3 + 1] - Sr.Q[1]) * Sr.u0[1] + (Sr.basePos[v * 3 + 2] - Sr.Q[2]) * Sr.u0[2];
    if (s <= 0) { n++; if (dist(vpos(Sr.pos, v), vpos(Sr.basePos, v)) !== 0) held++; }
  }
  ok(held === 0 && n > 100, 'everything of the limb more than 4 mm below the grab stayed (' + n + ' vertices held)');
  const rr = L.setReach(Sr, 1000);
  ok(Sr.reachClipped === true && Math.abs(Sr.reach - Sr.L) < 1e-12, 'a reach longer than the fork allows is cut to the fork and says so');
  const noMove = Sr.touched.every(v => Sr.pos[v * 3] === Sr.basePos[v * 3]);
  ok(noMove, 'changing the reach puts the piece back first');
}

/* ---------------------------------------------------------------- 6. limits and guards */
console.log('\n== 6. limits and guards');
{
  // the thick stub: a 4 mm limb that is 20 mm across cannot turn far
  const stubTip = 282;
  const Sk = L.prepare(soup, vpos(mesh.pos, stubTip), { ctx });
  const rk = L.displaceBy(Sk, 0, 100, toX);
  const fin = L.finish(Sk, { repair: REPAIR });
  ok(Sk.ok && rk.clampedAngle === true && rk.angleDeg < 100 && rk.angleDeg === rk.maxAngle * 180 / Math.PI,
     'a short fat stub (half-width ' + f3(Sk.half) + ' mm over ' + f3(Sk.reach) + ' mm) is held to ' + f3(rk.angleDeg) + ' deg, not the 100 asked');
  ok(fin.ok || /inside out|collapse|pass through/.test(fin.reason), 'and what it does turn is either clean or refused in words', fin.ok ? 'clean' : fin.reason);
}
{
  // bent through the trunk
  const Sp = L.prepare(soup, vpos(mesh.pos, 814), { ctx });
  const toTrunk = [-Sp.A[0], -Sp.A[1], 0];
  const rp = L.displaceBy(Sp, 0, 110, toTrunk);
  const fin = L.finish(Sp, { repair: REPAIR });
  ok(!fin.ok && /pass through the tree \(\d+ self-intersecting pairs? where it had 0\)/.test(fin.reason), 'a 110 degree bend of one twig through the trunk is refused', fin.reason);
  ok(fin.tris === soup, 'the refusal hands back the piece itself: nothing changed');
  L.displaceBy(Sp, 0, 20, toTrunk);
  ok(L.finish(Sp, { repair: REPAIR }).ok, 'the same twig bent 20 degrees the same way is fine (the guard measures, it does not forbid a direction)');
}
{
  // a hard bend of a grab on a branch that hooks nothing: the whole of the tree's tips, 90 degrees, one way
  let refused = 0, clean = 0;
  for (const tp of tips) {
    const Sx = L.prepare(soup, vpos(mesh.pos, tp), { ctx });
    if (!Sx.ok) continue;
    L.displaceBy(Sx, 0, 45, toX);
    if (L.finish(Sx, { repair: REPAIR }).ok) clean++; else refused++;
  }
  ok(clean >= tips.length - 3, '45 degrees towards +X on each of ' + tips.length + ' tips: ' + clean + ' clean, ' + refused + ' refused (a twig can hit a neighbour)');
}
{
  const t0 = Date.now();
  for (let q = 0; q < 20; q++) L.probe(ctx, vpos(mesh.pos, tips[q % tips.length]));
  const ms = (Date.now() - t0) / 20;
  ok(ms < 40, 'a hover probe costs ' + f3(ms) + ' ms on this tree');
}

console.log('\n' + (fail ? fail + ' FAILED, ' : '') + pass + ' checks passed' + (fail ? '\n  ' + FAILS.join('\n  ') : ''));
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* the temp dir is the OS's to clean */ }
process.exit(fail ? 1 : 0);
