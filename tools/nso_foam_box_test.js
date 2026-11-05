#!/usr/bin/env node
/* foamBox (nso_foam.js): foam in a box, bounded by the piece. In Node, on the
   fixtures of tools/nso_foam_fixtures.js and tools/nso_foam_box_fixtures.js
   and on library/box_closed.stl, with the shipped boolean kernel (nso_csg.js
   under tools/nso_csg_node.js) for the overlap check and the merge.

     node tools/nso_foam_box_test.js            exit 0 = every gate held
     node tools/nso_foam_box_test.js --vase     also times the 1.44M-triangle vase

   GATES
     1. box_closed.stl (two overlapping shells): today's Foam calls it "open to
        the outside"; foamBox merges the shells for this operation and fills the
        hollow. A box covering the hollow at amount 100 is today's Foam on the
        merged solid (and Fill / Densify), vertex for vertex.
     2. a box larger than the piece every way: every buried space filled, nothing
        outside the piece's surface (two sealed voids = Fill, bit for bit; a cup
        with a post and a sealed void in its floor = the closed form; a loose cube
        in a hollow welded in)
     3. a cup, the box through the bowl and out of the top: the bowl fills to the
        rim's outline and no higher, nothing outside the wall - square, stepped
        and slanted rims (the slanted one opens at a saddle, mid-wall)
     4. a box half inside a wall: only the buried half fills
     5. two voids in one box: both fill
     6. amount 25 / 50 / 75: added volume rises, 100 is all of it; sprays stack
     7. a yawed box and a posed piece
     8. refusals in words; paint (sub-region; a merge stands down for any paint)
     9. nothing outside the box changes: every triangle clear of it comes back
        bit for bit
    10. the old Foam is this engine with the box its hollow's bounds
    11. random boxes (yawed, at random amounts) against exact oracles: the buried
        cells of two voxel pieces, the slanted cup's prism, box_closed's hollow
    12. timings: box_closed and a vase
   and on the results, the canonical checker (tools/mesh_validate.py --gate,
   self-intersection included). */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');
const { readSTL, writeSTL } = require('./nso_stl_io.js');
const { csgContext } = require('./nso_csg_node.js');
const FX = require('./nso_foam_fixtures.js');
const BX = require('./nso_foam_box_fixtures.js');

const ROOT = path.join(__dirname, '..');
const MV = path.join(ROOT, 'tools', 'mesh_validate.py');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nso-foam-box-'));
const BIG_VASE = process.argv.includes('--vase');

const FOAM = require('../nso_foam.js');
const HOLLOW = require('../nso_hollow.js');

let pass = 0, fail = 0;
const FAILED = [];
function check(name, cond, detail) {
  console.log('  ' + (cond ? 'ok    ' : 'FAIL  ') + name + (detail !== undefined ? '   ' + detail : ''));
  if (cond) pass++; else { fail++; FAILED.push(name); }
}
const rel = (a, b) => Math.abs(a - b) / Math.max(1e-12, Math.abs(b));
const sameBytes = (a, b) => a.length === b.length &&
  Buffer.compare(Buffer.from(a.buffer, a.byteOffset, a.byteLength), Buffer.from(b.buffer, b.byteOffset, b.byteLength)) === 0;
const vol = s => HOLLOW.signedVolume(s, null);
function bounds(s) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < s.length; i += 3) for (let a = 0; a < 3; a++) { lo[a] = Math.min(lo[a], s[i + a]); hi[a] = Math.max(hi[a], s[i + a]); }
  return { lo, hi };
}
const sameBox = (A, B) => [0, 1, 2].every(a => A.lo[a] === B.lo[a] && A.hi[a] === B.hi[a]);
function triKeys(s) {
  const m = new Map();
  for (let t = 0; t < s.length / 9; t++) {
    const k = Array.prototype.slice.call(s, t * 9, t * 9 + 9).join(',');
    m.set(k, (m.get(k) || 0) + 1);
  }
  return m;
}
/* The result's triangles that are not the piece's own, bit for bit. */
function newTris(src, res) {
  const have = triKeys(src), out = [];
  for (let t = 0; t < res.length / 9; t++) {
    const k = Array.prototype.slice.call(res, t * 9, t * 9 + 9).join(',');
    if (have.get(k)) have.set(k, have.get(k) - 1); else out.push(res.subarray(t * 9, t * 9 + 9));
  }
  return out;
}

let canonN = 0;
function canonical(soup) {
  const p = path.join(TMP, 'b' + (canonN++) + '.stl');
  writeSTL(p, soup, 'nso foam box');
  let out, gate = true;
  try { out = execFileSync('python3', [MV, p, '--json', '--gate'], { maxBuffer: 1 << 28 }); }
  catch (e) { out = e.stdout; gate = false; }
  const j = JSON.parse(out.toString());
  j.gatePass = gate;
  return j;
}
function gateCanonical(tag, soup) {
  const cj = canonical(soup);
  check(tag + ': canonical checker --gate passes', cj.gatePass && cj.open_edges === 0 && cj.nonmanifold_edges === 0 &&
        cj.inconsistent_winding_edges === 0 && cj.self_intersection.pierce === 0 && !cj.degenerate_tris,
        'open ' + cj.open_edges + ', nm ' + cj.nonmanifold_edges + ', winding ' + cj.inconsistent_winding_edges +
        ', pierce ' + cj.self_intersection.pierce + ', degen ' + cj.degenerate_tris);
}
/* What every set result is held to: closed by census, the volume it says it
   added, the input never written to. */
function gateSet(tag, src, r, expect, tol, base) {
  check(tag + ': set', r.ok && r.changed, r.reason);
  if (!(r.ok && r.changed)) return false;
  src = base || src;           // a merged piece gains its volume over the merged solid
  const cs = FOAM.census(r.mesh);
  check(tag + ': closed, 2-manifold, nothing collapsed (census)', cs.closed && !cs.degen, cs.open + ' open, ' + cs.nm + ' nm, ' + cs.degen + ' degen');
  check(tag + ': the piece gained exactly the volume it says', rel(vol(r.mesh) - vol(src), r.addedVolume) < 1e-9,
        (vol(r.mesh) - vol(src)).toFixed(4) + ' vs ' + r.addedVolume.toFixed(4));
  if (expect != null) {
    check(tag + ': added volume = the closed form', rel(r.addedVolume, expect) < (tol || 1e-6),
          r.addedVolume.toFixed(4) + ' vs ' + expect.toFixed(4));
  }
  return true;
}
const piece = (soup, more) => Object.assign({ rawTris: soup, skipList: [] }, more || {});
const solid = (soup, box, amount, more, opts) => FOAM.foamBoxSolid(piece(soup, more), box, amount, opts);

(async function main() {
  const K = csgContext();
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'NSO_Repair.js'), 'utf8'), K, { filename: 'NSO_Repair.js' });
  const OV = { measure: K.NSO_overlapMeasure, merge: K.NSO_shellMergeCore };
  const fb = (soup, box, amount, more, opts) => FOAM.foamBox(piece(soup, more), box, amount, Object.assign({ overlap: OV }, opts || {}));
  const timings = {};

  /* ------------------------------------------------------------------ */
  console.log('\n== 1. box_closed.stl: two overlapping shells ==');
  {
    const src = new Float32Array(readSTL(path.join(ROOT, 'library', 'box_closed.stl')));
    const before = Float32Array.from(src);
    const today = FOAM.analyse(src);
    check('today\'s Foam on the raw shells: the false flag, "open to the outside"', today.kind === 'open', today.reason);
    const merged = await K.NSO_shellMergeCore(src);
    const A = FOAM.analyse(merged.soup);
    check('...the merged solid has one sealed hollow (the tray under the lid)', A.ok && A.cavities.length === 1, A.reason);
    const cv = A.cavities[0];
    const cover = { c: [30, 20, 13], h: [35, 25, 16], yaw: 0 };
    const tm = {}, t0 = Date.now();
    const r = await fb(src, cover, 100, { name: 'box_closed' }, { timings: tm });
    timings.boxClosed = { ms: Date.now() - t0, stages: tm, tris: src.length / 9 };
    gateSet('a box covering the hollow, 100', src, r, null, null, merged.soup);
    check('...merged for this operation, and it says so', r.merged === 'box_closed had 2 overlapping shells - merged for this operation' &&
          /merged for this operation/.test(r.reason), r.reason);
    check('...welded to both shells it meets: the tray (0) and the lid (1)', JSON.stringify(r.touched) === '[0,1]', JSON.stringify(r.touched));
    check('...the volume added is the hollow\'s', rel(r.addedVolume, cv.volume) < 1e-6, r.addedVolume.toFixed(3) + ' vs ' + cv.volume.toFixed(3));
    const old = FOAM.foam(merged.soup, A, 0, cv.height, { skipList: [] });
    check('amount 100 = today\'s Foam (Fill it all) on the merged solid, vertex for vertex', old.ok && sameBytes(r.mesh, old.soup),
          (r.mesh.length / 9) + ' vs ' + (old.soup.length / 9) + ' tris');
    const fill = HOLLOW.fill(merged.soup, {});
    check('...and = Fill / Densify on it, vertex for vertex', fill.ok && sameBytes(r.mesh, fill.soup));
    gateCanonical('box_closed filled', r.mesh);
    check('the piece as it came was never written to', sameBytes(src, before));
    // a box over part of the hollow: from its floor (z 2) up to the lid's underside (z 24.9)
    const part = await fb(src, { c: [20, 10, 20], h: [10, 5, 20] }, 100, { name: 'box_closed' });
    gateSet('a box over part of the hollow', src, part, 20 * 10 * (Math.fround(24.9) - 2), 1e-6, merged.soup);
    const amts = [];
    for (const a of [25, 50, 75, 100]) amts.push((await fb(src, cover, a, { name: 'box_closed' })).addedVolume);
    check('amount 25 / 50 / 75 / 100 rise, 100 is the hollow', amts[0] > 0 && amts[0] < amts[1] && amts[1] < amts[2] && amts[2] < amts[3] &&
          rel(amts[3], cv.volume) < 1e-6 && rel(amts[1], cv.volume / 2) < 1e-6, amts.map(v => v.toFixed(1)).join(' < '));
  }

  console.log('\n== 2. a box larger than the piece every way: every buried space filled ==');
  {
    const B2 = FX.box2();
    const big = { c: [0, 0, 0], h: [50, 30, 30] };
    const r = solid(B2.soup, big, 100);
    gateSet('two sealed voids', B2.soup, r, 20 * 20 * 24 + 20 * 20 * 10);
    const fill = HOLLOW.fill(B2.soup, {});
    check('...the result is the piece with both filled: Fill / Densify\'s output, bit for bit', fill.ok && sameBytes(r.mesh, fill.soup));
    check('...welded to the two void shells (1, 2), not the outside (0)', JSON.stringify(r.touched) === '[1,2]', JSON.stringify(r.touched));

    const C = BX.composite();
    const box = { c: [0, 0, 20], h: [25, 25, 30] };
    const rc = solid(C.soup, box, 100);
    gateSet('a cup with a post and a sealed void in its floor', C.soup, rc, C.filled - C.volume);
    check('...the result\'s volume is the cup solid to its rim plus the post above it', rel(vol(rc.mesh), C.filled) < 1e-9, vol(rc.mesh) + ' vs ' + C.filled);
    check('...nothing outside the piece: its box is the piece\'s, to the bit', sameBox(bounds(rc.mesh), bounds(C.soup)));
    const fresh = newTris(C.soup, rc.mesh);
    check('...every new face is the rim\'s outline at z 30, round the post', fresh.length > 0 &&
          fresh.every(t => t[2] === 30 && t[5] === 30 && t[8] === 30), fresh.length + ' new faces');
    const again = solid(rc.mesh, box, 100);
    check('...and nothing buried is left: a second fill is refused, in words', !again.ok && again.kind === 'none' &&
          /no buried empty space in the box/.test(again.reason), again.reason);
    gateCanonical('composite filled', rc.mesh);

    const Cp = FX.captive();
    const rk = solid(Cp.soup, { c: [0, 0, 0], h: [25, 25, 25] }, 100);
    gateSet('a hollow with a loose cube in it', Cp.soup, rk, 30 * 30 * 30 - 10 * 10 * 10);
    check('...the cube is welded in, not held on its own shell: the result is the 40 mm block, one shell',
          rk.mesh.length / 9 === 12 && rel(vol(rk.mesh), 64000) < 1e-12 && JSON.stringify(rk.touched) === '[1,2]',
          (rk.mesh.length / 9) + ' tris, touched ' + JSON.stringify(rk.touched));

    const cup = FX.cup().soup;
    const rcu = solid(cup, { c: [0, 0, 0], h: [40, 40, 60] }, 100);
    gateSet('the plain cup', cup, rcu, 26 * 26 * 28);
    check('...is a solid 30 mm block', rel(vol(rcu.mesh), 27000) < 1e-12 && sameBox(bounds(rcu.mesh), bounds(cup)), vol(rcu.mesh));
  }

  console.log('\n== 3. a cup, the box through the bowl and out of the top ==');
  {
    const cup = FX.cup().soup, cb = bounds(cup);
    const wide = solid(cup, { c: [0, 0, 26], h: [20, 20, 25] }, 100);
    gateSet('a box wider than the cup, z 1 to 51', cup, wide, 26 * 26 * 28);
    check('...the bowl fills to the rim and no higher, nothing outside the wall', sameBox(bounds(wide.mesh), cb) && wide.level === 30,
          'level ' + wide.level);
    const thin = solid(cup, { c: [0, 0, 25], h: [5, 5, 27] }, 100);
    gateSet('a 10 x 10 box from under the floor to above the rim', cup, thin, 10 * 10 * 28);
    check('...it stops at the rim\'s height and welds to the floor', sameBox(bounds(thin.mesh), cb) && thin.level === 30 &&
          JSON.stringify(thin.touched) === '[0]', 'level ' + thin.level + ', touched ' + JSON.stringify(thin.touched));
    gateCanonical('box through the bowl', thin.mesh);
    const free = solid(cup, { c: [0, 0, 25], h: [5, 5, 10] }, 100);
    gateSet('a box in the bowl clear of the floor (z 15 to 35)', cup, free, 10 * 10 * 15);
    check('...welds to nothing and says so - it stands free in the space it filled', free.touched.length === 0 &&
          /stands free/.test(free.reason), free.reason);

    const S = BX.slantCup(48), sb = bounds(S.soup);
    const rs = solid(S.soup, { c: [0, 0, 20], h: [20, 20, 25] }, 100);
    gateSet('a slanted rim (z = 20 + 0.3 x)', S.soup, rs, S.bowlArea * (Math.fround(S.opening) - S.floor), 1e-6);
    check('...it fills to the inner rim\'s lowest corner, where the wall opens, ' + S.opening.toFixed(1) + ' mm',
          Math.abs(rs.level - S.opening) < 1e-5, 'level ' + rs.level);
    // every new face above the opening is a piece of one of the cup's own faces (an inner wall cut at the opening)
    const own = [];
    for (let t = 0; t < S.soup.length / 9; t++) {
      const o = t * 9, a = [S.soup[o], S.soup[o + 1], S.soup[o + 2]];
      const u = [S.soup[o + 3] - a[0], S.soup[o + 4] - a[1], S.soup[o + 5] - a[2]], v = [S.soup[o + 6] - a[0], S.soup[o + 7] - a[1], S.soup[o + 8] - a[2]];
      const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]], l = Math.hypot(n[0], n[1], n[2]);
      own.push([n[0] / l, n[1] / l, n[2] / l, (n[0] * a[0] + n[1] * a[1] + n[2] * a[2]) / l]);
    }
    const onOwn = t => own.some(p => [0, 3, 6].every(k => Math.abs(p[0] * t[k] + p[1] * t[k + 1] + p[2] * t[k + 2] - p[3]) < 1e-4));
    const above = newTris(S.soup, rs.mesh).filter(t => Math.max(t[2], t[5], t[8]) > Math.fround(S.opening));
    check('...nothing above it and nothing outside the wall', sameBox(bounds(rs.mesh), sb) && above.every(onOwn),
          above.length + ' new faces above the opening, all on the cup\'s own faces');
    check('...the inner walls - one tall quad each - were cut at that height', rs.info && rs.info.walls === 144 && rs.mended === 0,
          JSON.stringify(rs.info));
    gateCanonical('slanted rim filled', rs.mesh);
    const St = BX.stepCup();
    const rt = solid(St.soup, { c: [0, 0, 20], h: [20, 20, 25] }, 100);
    gateSet('a stepped rim, 20 mm on the -X wall to 28 mm on the +X', St.soup, rt, St.bowl);
    check('...it fills to the lowest step, 20 mm', rt.level === 20 && sameBox(bounds(rt.mesh), bounds(St.soup)), 'level ' + rt.level);
  }

  console.log('\n== 4. a box half inside a wall ==');
  {
    const cup = FX.cup().soup, cb = bounds(cup);
    const half = solid(cup, { c: [15, 0.7, 20], h: [10, 5, 15] }, 100);
    gateSet('the cup: x 5 to 25 across the +X wall (13 to 15)', cup, half, 8 * 10 * 25);
    const inner = solid(cup, { c: [9, 0.7, 20], h: [4, 5, 15] }, 100);
    check('...the outside half adds nothing: the same fill as the box cut back to the bowl', rel(half.addedVolume, inner.addedVolume) < 1e-9 &&
          sameBox(bounds(half.mesh), cb), half.addedVolume + ' vs ' + inner.addedVolume);
    const odd = solid(cup, { c: [14.2, 0.7, 25], h: [10, 4.3, 15.3] }, 100);
    gateSet('...a box off the grid, out past the rim', cup, odd, (13 - 4.2) * (5.0 - (-3.6)) * (30 - 9.7), 1e-6);
    check('...the rim faces it cuts across are split where the foam\'s edge meets them, nothing left open', odd.mended > 0, odd.mended + ' faces split');
    gateCanonical('cup, box half in the wall', odd.mesh);

    const B1 = FX.box1();
    const rb = solid(B1.soup, { c: [17.5, 0, 0], h: [12.5, 5, 5] }, 100);
    gateSet('a sealed hollow: a box from inside it out through its 5 mm wall', B1.soup, rb, 10 * 10 * 10);
    check('...nothing outside the piece', sameBox(bounds(rb.mesh), bounds(B1.soup)));
    gateCanonical('sealed hollow, box half in the wall', rb.mesh);
  }

  console.log('\n== 5. two voids in one box ==');
  {
    const B2 = FX.box2();
    const r = solid(B2.soup, { c: [0, 0, -4], h: [20, 8, 6] }, 100);
    // x -20..20 takes 15 of each void's 20; y -8..8 is 16 of 20; z -10..2 from each floor (-12) up
    gateSet('a box across both voids of box2', B2.soup, r, 15 * 16 * (2 - (-10)) + 15 * 16 * (-2 - (-10)));
    check('...both fill: welded to both void shells', JSON.stringify(r.touched) === '[1,2]', JSON.stringify(r.touched));
    const C = BX.composite();
    const rc = solid(C.soup, { c: [0, 0, 10], h: [14, 14, 8.5] }, 100);
    // z 1.5..18.5: the sealed void (z 2..4) whole, and the bowl from its floor (6) up to 18.5, round the post
    gateSet('a sealed void in the floor and the open bowl above it', C.soup, rc, C.voidVolume + (26 * 26 - 36) * (18.5 - 6));
  }

  console.log('\n== 6. amount: 25 / 50 / 75 rise, 100 is all of it; sprays stack ==');
  {
    const B2 = FX.box2(), box = { c: [0, 0, 0], h: [50, 30, 30] };
    const v = [25, 50, 75, 100].map(a => solid(B2.soup, box, a).addedVolume);
    check('box2: 4,800 < 8,800 < 11,200 < 13,600 mm³', JSON.stringify(v) === '[4800,8800,11200,13600]', JSON.stringify(v));
    const S = BX.slantCup(48), sbox = { c: [0, 0, 20], h: [20, 20, 25] };
    const sv = [25, 50, 75, 100].map(a => solid(S.soup, sbox, a).addedVolume);
    check('the slanted cup: rises, linear in the level, 100 the whole bowl', sv[0] < sv[1] && sv[1] < sv[2] && sv[2] < sv[3] &&
          rel(sv[1], sv[3] / 2) < 1e-6, sv.map(x => x.toFixed(1)).join(' < '));
    const s1 = solid(B2.soup, box, 50), s2 = solid(s1.mesh, box, 50), s75 = solid(B2.soup, box, 75);
    gateSet('a second spray of 50 on the first', s1.mesh, s2, null);
    check('...takes the previous result: 50 then 50 = 75 from the start', rel(vol(s2.mesh), vol(s75.mesh)) < 1e-9,
          vol(s2.mesh).toFixed(3) + ' vs ' + vol(s75.mesh).toFixed(3));
    const z0 = solid(B2.soup, box, 0);
    check('amount 0: nothing to set, the piece handed back', z0.ok && !z0.changed && z0.mesh === B2.soup, z0.reason);
  }

  console.log('\n== 7. a yawed box, a posed piece ==');
  {
    const cup = FX.cup().soup;
    const ry = solid(cup, { c: [0, 0, 15], h: [5, 3, 20], yaw: 30 }, 100);
    gateSet('a box yawed 30° inside the bowl', cup, ry, 10 * 6 * 28, 1e-6);
    gateCanonical('yawed box', ry.mesh);
    // the cup lying on its side in its raw axes: raw = (x, -z, y) of the plate frame
    const side = new Float32Array(cup.length);
    for (let i = 0; i < cup.length; i += 3) { side[i] = cup[i]; side[i + 1] = -cup[i + 2]; side[i + 2] = cup[i + 1]; }
    const toRaw = [1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1];
    const rp = solid(side, { c: [0, 0, 25], h: [5, 5, 27] }, 100, { toRaw });
    gateSet('a piece posed on its side (toRaw), the box in the plate frame', side, rp, 10 * 10 * 28);
    const rq = solid(side, { c: [0, 0, 25], h: [5, 5, 27], yaw: 17 }, 100, { toRaw: [0.8, 0.6, 0, 0, 0, 0, 1, 0, 0.6, -0.8, 0, 0, 3, -2, 1, 1] });
    // a turned and moved pose: the plate frame's z is the raw (0.6, -0.8, 0)... the fill is the box's, whatever the frame
    check('a turned, moved pose and a yawed box: the piece stays closed and gains what it says',
          rq.ok && (!rq.changed || (FOAM.census(rq.mesh).closed && rel(vol(rq.mesh) - vol(side), rq.addedVolume) < 1e-6)), rq.reason);
  }

  console.log('\n== 8. refusals, paint ==');
  {
    const cup = FX.cup().soup;
    const air = solid(cup, { c: [60, 0, 10], h: [5, 5, 5] }, 100);
    check('a box in the air beside the piece: no buried empty space, in words, the piece handed back',
          !air.ok && air.kind === 'none' && air.mesh === cup && /no buried empty space in the box/.test(air.reason), air.reason);
    const inWall = solid(cup, { c: [14, 0, 10], h: [0.5, 5, 5] }, 100);
    check('a box inside the wall\'s material: the same', !inWall.ok && inWall.kind === 'none', inWall.reason);
    const above = solid(cup, { c: [0, 0, 40], h: [10, 10, 5] }, 100);
    check('a box over the rim, in the air the cup does not bury: the same', !above.ok && above.kind === 'none', above.reason);
    const noSkip = FOAM.foamBoxSolid({ rawTris: cup }, { c: [0, 0, 20], h: [5, 5, 5] }, 100);
    check('no skip list: refused - never assumed unpainted', !noSkip.ok && /skip list/.test(noSkip.reason), noSkip.reason);
    const badBox = solid(cup, { c: [0, 0, 20], h: [5, 0, 5] }, 100);
    check('a box with no size: refused in words', !badBox.ok && /half-sizes above 0/.test(badBox.reason), badBox.reason);
    // paint: the bowl's floor top (z 2, facing +Z) is a face the foam welds to; the outside of the -X wall is not
    const floorPaint = { axisIdx: 2, keepMin: false, d: 2, inner: true };
    const wallPaint = { axisIdx: 0, keepMin: true, d: 15, inner: false };
    const rp = solid(cup, { c: [0, 0, 25], h: [5, 5, 27] }, 100, { skipList: [floorPaint] });
    check('a painted face the foam would weld to stands it down, named', !rp.ok && rp.kind === 'painted' && rp.mesh === cup &&
          /Foam stood down - the inner Z\+ face at 2\.00 is painted/.test(rp.reason), rp.reason);
    const ro = solid(cup, { c: [0, 0, 25], h: [5, 5, 27] }, 100, { skipList: [wallPaint] });
    check('paint elsewhere does not', ro.ok && ro.changed, ro.reason);
    const hi = solid(cup, { c: [0, 0, 25], h: [5, 5, 10] }, 100, { skipList: [floorPaint] });
    check('...nor does paint on a face this box does not reach', hi.ok && hi.changed, hi.reason);
    const src = new Float32Array(readSTL(path.join(ROOT, 'library', 'box_closed.stl')));
    const rm = await fb(src, { c: [30, 20, 13], h: [35, 25, 16] }, 100, { name: 'box_closed', skipList: [wallPaint] });
    check('a piece whose shells must be merged stands down for any paint - the merge replaces every triangle',
          !rm.ok && rm.kind === 'painted' && rm.mesh === src && /merging them for the fill replaces every triangle/.test(rm.reason), rm.reason);
    const open = cup.slice(0, cup.length - 9);
    const ro2 = await fb(open, { c: [0, 0, 20], h: [5, 5, 5] }, 100);
    check('a piece that is not closed: refused in words (the merge cannot close it either)', !ro2.ok && /not a closed solid/.test(ro2.reason), ro2.reason);
  }

  console.log('\n== 9. nothing outside the box changes ==');
  {
    for (const [tag, src, box] of [['cup, box half in the wall', FX.cup().soup, { c: [14.2, 0.7, 25], h: [10, 4.3, 15.3] }],
                                   ['slanted cup, a box low in the bowl', BX.slantCup(48).soup, { c: [3, -2, 6], h: [5, 4, 3] }],
                                   ['composite, a yawed box', BX.composite().soup, { c: [-5, 4, 12], h: [4, 6, 9], yaw: 25 }]]) {
      const r = solid(src, box, 100);
      check(tag + ': set', r.ok && r.changed, r.reason);
      if (!r.ok) continue;
      const th = (box.yaw || 0) * Math.PI / 180, c = Math.cos(th), s = Math.sin(th);
      const clear = [];
      for (let t = 0; t < src.length / 9; t++) {
        // clear of the box: all three corners outside one of its six faces, by more than the weld radius
        let outFace = false;
        for (let a = 0; a < 3 && !outFace; a++) for (const sg of [-1, 1]) {
          let all = true;
          for (let k = 0; k < 3; k++) {
            const o = t * 9 + k * 3, dx = src[o] - box.c[0], dy = src[o + 1] - box.c[1], dz = src[o + 2] - box.c[2];
            const q = [dx * c + dy * s, -dx * s + dy * c, dz];
            if (!(sg * q[a] > box.h[a] + 1e-3)) { all = false; break; }
          }
          if (all) { outFace = true; break; }
        }
        if (outFace) clear.push(t);
      }
      const have = triKeys(r.mesh);
      const kept = clear.filter(t => have.has(Array.prototype.slice.call(src, t * 9, t * 9 + 9).join(',')));
      check(tag + ': every triangle clear of the box is in the result, bit for bit', kept.length === clear.length,
            kept.length + ' of ' + clear.length);
      gateCanonical(tag, r.mesh);
    }
  }

  console.log('\n== 10. the old Foam is foamBox with the box its hollow\'s bounds ==');
  {
    const src = readSTL(path.join(ROOT, 'fixtures', 'box_cavity_30.stl'));
    const A = FOAM.analyse(src), cv = A.cavities[0];
    const old = FOAM.foam(src, A, 0, 10, { skipList: [] });
    const box = { c: [0, 0, 0], h: [13, 13, 13] };
    const nw = solid(src, box, 10 / cv.height * 100);
    check('box_cavity_30 at 10 mm: Set and foamBox add the same volume', old.ok && nw.ok && rel(nw.addedVolume, old.removedVolume) < 1e-9,
          nw.addedVolume.toFixed(3) + ' vs ' + old.removedVolume.toFixed(3));
    const top = solid(src, box, 100), fill = HOLLOW.fill(src, {});
    check('...and at 100, Fill / Densify\'s output, bit for bit', sameBytes(top.mesh, fill.soup));
  }

  console.log('\n== 11. random boxes against exact oracles ==');
  {
    let seed = 20261022;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    const ov = (a0, a1, b0, b1) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
    /* Convex polygon area, and a convex polygon clipped by a half-plane. */
    const polyArea = p => { let a = 0; for (let i = 0; i < p.length; i++) { const q = p[i], r = p[(i + 1) % p.length]; a += q[0] * r[1] - r[0] * q[1]; } return a / 2; };
    const clipHalf = (p, nx, ny, d) => {        // keep nx x + ny y <= d
      const out = [];
      for (let i = 0; i < p.length; i++) {
        const a = p[i], b = p[(i + 1) % p.length], da = nx * a[0] + ny * a[1] - d, db = nx * b[0] + ny * b[1] - d;
        if (da <= 0) out.push(a);
        if ((da < 0 && db > 0) || (da > 0 && db < 0)) { const t = da / (da - db); out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]); }
      }
      return out;
    };
    /* The buried space of a voxel cup inside an axis box: the empty cells a layer's walls enclose. */
    function voxelOracle(buried, box) {
      let v = 0;
      for (const [i, j, k] of buried) {
        const x0 = -15 + 2 * i, y0 = -15 + 2 * j, z0 = 2 * k;
        v += ov(x0, x0 + 2, box.lo[0], box.hi[0]) * ov(y0, y0 + 2, box.lo[1], box.hi[1]) * ov(z0, z0 + 2, box.lo[2], box.hi[2]);
      }
      return v;
    }
    const cupB = [], compB = [];
    for (let i = 1; i < 14; i++) for (let j = 1; j < 14; j++) for (let k = 1; k < 15; k++) cupB.push([i, j, k]);
    const C = BX.composite(), filled = new Set(C.cells.map(c => c.join(',')));
    for (let i = 1; i < 14; i++) for (let j = 1; j < 14; j++) for (let k = 0; k < 15; k++) if (!filled.has(i + ',' + j + ',' + k)) compB.push([i, j, k]);
    const cases = [['the cup', FX.cup().soup, cupB], ['the composite', C.soup, compB]];
    for (const [tag, src, buried] of cases) {
      let ok = 0, worst = 0, closed = 0, clearOk = 0, n = 0;
      for (let q = 0; q < 30; q++) {
        const c = [-20 + 40 * rnd(), -20 + 40 * rnd(), -5 + 45 * rnd()], h = [1 + 14 * rnd(), 1 + 14 * rnd(), 1 + 20 * rnd()];
        const box = { c, h }, lim = { lo: [c[0] - h[0], c[1] - h[1], c[2] - h[2]], hi: [c[0] + h[0], c[1] + h[1], c[2] + h[2]] };
        const want = voxelOracle(buried, lim), r = solid(src, box, 100);
        n++;
        if (want < 1e-9) { if (!r.ok && r.kind === 'none') { ok++; closed++; clearOk++; } continue; }
        // the box's faces land on float32 corners: allow their rounding (1e-6 of the volume, and 5e-3 mm³)
        const e = r.ok ? Math.abs(r.addedVolume - want) : Infinity;
        worst = Math.max(worst, e);
        if (e < 1e-6 * want + 5e-3) ok++;
        if (r.ok && q % 6 === 0) gateCanonical(tag + ', random box ' + q, r.mesh);
        const cs = r.ok ? FOAM.census(r.mesh) : null;
        if (cs && cs.closed && !cs.degen) closed++;
        if (r.ok && newTris(src, r.mesh).every(t => [0, 3, 6].every(k => t[k] >= lim.lo[0] - 1e-3 && t[k] <= lim.hi[0] + 1e-3 &&
            t[k + 1] >= lim.lo[1] - 1e-3 && t[k + 1] <= lim.hi[1] + 1e-3 && t[k + 2] >= lim.lo[2] - 1e-3 && t[k + 2] <= lim.hi[2] + 1e-3) ||
            [0, 3, 6].some(k => t[k] >= lim.lo[0] - 1e-3 && t[k] <= lim.hi[0] + 1e-3 && t[k + 1] >= lim.lo[1] - 1e-3 &&
            t[k + 1] <= lim.hi[1] + 1e-3 && t[k + 2] >= lim.lo[2] - 1e-3 && t[k + 2] <= lim.hi[2] + 1e-3))) clearOk++;
      }
      check(tag + ': 30 random boxes - the fill is the buried cells inside each, to float32\'s rounding', ok === n, ok + ' of ' + n + ', worst ' + worst.toExponential(2) + ' mm³');
      check(tag + ': ...every result closed', closed === n, closed + ' of ' + n);
      check(tag + ': ...and every face that changed touches the box', clearOk === n, clearOk + ' of ' + n);
    }
    // the slanted cup's buried space is the 48-gon prism z 2..16.1: a yawed box is a turned rectangle
    const S = BX.slantCup(48), gon = [];
    for (let i = 0; i < 48; i++) gon.push([13 * Math.cos(2 * Math.PI * i / 48), 13 * Math.sin(2 * Math.PI * i / 48)]);
    let ok = 0, worst = 0, closed = 0, n = 0;
    for (let q = 0; q < 30; q++) {
      const c = [-16 + 32 * rnd(), -16 + 32 * rnd(), -2 + 26 * rnd()], h = [1 + 10 * rnd(), 1 + 10 * rnd(), 1 + 12 * rnd()];
      const yaw = q % 2 ? 180 * rnd() - 90 : 0, amount = q % 3 === 0 ? 100 : Math.round(100 * rnd());
      const th = yaw * Math.PI / 180, ux = [Math.cos(th), Math.sin(th)], uy = [-Math.sin(th), Math.cos(th)];
      let p = gon.slice();
      for (const [nv, hh] of [[ux, h[0]], [uy, h[1]]]) {
        p = clipHalf(p, nv[0], nv[1], nv[0] * c[0] + nv[1] * c[1] + hh);
        if (p.length) p = clipHalf(p, -nv[0], -nv[1], -(nv[0] * c[0] + nv[1] * c[1]) + hh);
      }
      const area = p.length >= 3 ? polyArea(p) : 0, zlo = Math.max(c[2] - h[2], 2), zhi = Math.min(c[2] + h[2], Math.fround(S.opening));
      const want = area > 1e-9 && zhi > zlo ? area * (zhi - zlo) * amount / 100 : 0;
      const r = solid(S.soup, { c, h, yaw }, amount);
      n++;
      if (want < 1e-6) { if ((!r.ok && r.kind === 'none') || (r.ok && !r.changed)) { ok++; closed++; } continue; }
      const e = r.ok && r.changed ? Math.abs(r.addedVolume - want) : Infinity;
      worst = Math.max(worst, e);
      if (e < 1e-6 * want + 5e-3) ok++;
      if (r.ok && r.changed && q % 6 === 1) gateCanonical('slanted cup, random box ' + q, r.mesh);
      const cs = r.ok && r.changed ? FOAM.census(r.mesh) : null;
      if (cs && cs.closed && !cs.degen) closed++;
    }
    check('the slanted cup: 30 random boxes, yawed and at random amounts - the closed form, to float32\'s rounding', ok === n, ok + ' of ' + n + ', worst ' + worst.toExponential(2) + ' mm³');
    check('...every result closed', closed === n, closed + ' of ' + n);
    // box_closed, merged: the hollow is the box x 2..58, y 2..38, z 2..24.9
    const src = new Float32Array(readSTL(path.join(ROOT, 'library', 'box_closed.stl')));
    const merged = await K.NSO_shellMergeCore(src);
    let okb = 0, nb = 0, worstb = 0;
    for (let q = 0; q < 12; q++) {
      const c = [-5 + 70 * rnd(), -5 + 50 * rnd(), -2 + 30 * rnd()], h = [2 + 20 * rnd(), 2 + 15 * rnd(), 1 + 12 * rnd()];
      const want = ov(c[0] - h[0], c[0] + h[0], 2, 58) * ov(c[1] - h[1], c[1] + h[1], 2, 38) * ov(c[2] - h[2], c[2] + h[2], 2, Math.fround(24.9));
      const r = await fb(src, { c, h }, 100, { name: 'box_closed' });
      nb++;
      if (want < 1e-9) { if (!r.ok && r.kind === 'none') okb++; continue; }
      const e = r.ok ? rel(r.addedVolume, want) : 1;
      worstb = Math.max(worstb, e);
      if (e < 1e-6 && FOAM.census(r.mesh).closed && rel(vol(r.mesh) - vol(merged.soup), r.addedVolume) < 1e-9) okb++;
    }
    check('box_closed: 12 random boxes - box x hollow, every result closed', okb === nb, okb + ' of ' + nb + ', worst ' + worstb.toExponential(2));
  }

  console.log('\n== 12. timings ==');
  {
    const bc = timings.boxClosed;
    console.log('  box_closed (' + bc.tris + ' tris, the merge included): ' + bc.ms + ' ms; engine stages ' +
                JSON.stringify(Object.fromEntries(Object.entries(bc.stages).map(([k, v]) => [k, +v.toFixed(1)]))));
    const sizes = BIG_VASE ? [[240, 160], [720, 500]] : [[240, 160]];
    for (const [n, m] of sizes) {
      const V = BX.vase(n, m), tris = V.soup.length / 9;
      for (const [tag, box] of [['the whole vase', { c: [0, 0, 80], h: [60, 60, 90] }], ['a box at its side', { c: [30, 0, 60], h: [12, 10, 15], yaw: 20 }]]) {
        const tm = {}, t0 = Date.now();
        const r = solid(V.soup, box, 100, null, { timings: tm });
        const ms = Date.now() - t0;
        console.log('  vase ' + tris.toLocaleString() + ' tris, ' + tag + ': ' + ms + ' ms ' +
                    JSON.stringify(Object.fromEntries(Object.entries(tm).map(([k, v]) => [k, Math.round(v)]))));
        check('vase ' + tris + ' tris, ' + tag + ': set and closed', r.ok && r.changed && r.census.closed && !r.census.degen, r.reason);
        if (tag === 'the whole vase') check('...the bowl fills to the wavy rim\'s lowest corner, ' + V.lowRim.toFixed(1) + ' mm',
                                           Math.abs(r.level - V.lowRim) < 1e-4, 'level ' + r.level);
      }
    }
  }

  fs.rmSync(TMP, { recursive: true, force: true });
  console.log('\npassed ' + pass + ' check(s), ' + fail + ' failure(s)');
  if (fail) { console.log('FAILED:\n  ' + FAILED.join('\n  ')); process.exit(1); }
})().catch(e => { console.error(e); process.exit(1); });
