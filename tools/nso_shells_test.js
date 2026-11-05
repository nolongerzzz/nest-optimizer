#!/usr/bin/env node
/* Shells as pieces - the engine (nso_shells.js, and nso_split_parts.js on top of it). Node only.
     node tools/nso_shells_test.js        exit 0 = every gate held
   (npm run shells:test)

   THE RULE: a closed shell that crosses another is a part; one that stands free is a part; one wholly inside another
   with no crossing is a cavity. docs/SHELLS-AS-PIECES.md.

     1. the classifier's reading of box_closed (the library's own: a tray and a lid laid through each other, 74
        piercing pairs): two shells, each crosses the other, both parts, Lift owns it; the crossing it counts is
        the one NSO_Repair counts (its _overlapShells: 10 truly crossing pairs, 2 shells)
     2. a hollow box: one part, the hollow inside it is a cavity of shell 1 and is not liftable; Lift does not own it
     3. the vase (generated here: a lathe body and a handle shell sunk into its wall; the user's own is
        tools/fixtures-local/, uncommitted - this is its structure, not its mesh): body + handle cross; the handle
        wound inward reads the same; a vase with no handle is one part
     4. a free second shell (a cube well apart from the body) is a part, clear of the rest; Lift owns that too;
        shells that interleave without crossing (the print-in-place hinge) are parts Lift does NOT own
     5. Split to parts: box_closed -> 2 pieces (68 + 12 triangles), every triangle bit for bit and once, each with no
        piercing pair, the pieces' boxes the original's; the vase -> body + handle; a pin through a block, either
        winding -> 2 parts, never a hollow; a free second shell -> 2 parts as it was
     6. nothing else changed: split() on the fixtures with no crossing is the engine as it was, hash for hash
        (a hollow box is "1 part", the hollow stays with its shell)
     7. the export check: the two halves Split left laid through each other are named in one line; pieces apart, or
        touching, or one in the other's hollow, say nothing
     8. what a shell lift is made of: the shell and what is left are each bit for bit, once, in order
     9. timings of the classifier (reported, and held to a bound) on the small vase and a 1.5 M-triangle one */
'use strict';

const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
global.window = global;
require(path.join(ROOT, 'NSO_Repair.js'));
const SH = require(path.join(ROOT, 'nso_shells.js'));
const SP = require(path.join(ROOT, 'nso_split_parts.js'));
const FX = require('./nso_split_parts_fixtures.js');
const SX = require('./nso_shells_fixtures.js');
const crypto = require('crypto');
const LIB = require('./nso_lift_plate_drive_lib.js');
const C = LIB.makeCheck(), check = C.check;
const R = global.NSO_Repair;

function readStl(p) {
  const b = fs.readFileSync(p), n = b.readUInt32LE(80), a = new Float32Array(n * 9);
  for (let i = 0; i < n; i++) for (let k = 0; k < 9; k++) a[i * 9 + k] = b.readFloatLE(84 + i * 50 + 12 + k * 4);
  return a;
}
const piercings = soup => { const w = R._weldToIndexed(soup, R.WELD_TOL); return R._selfIntersectionDetail(w.mesh, { collect: true }).pierce; };
const triKey = (s, t) => Array.from(s.slice(t * 9, t * 9 + 9)).join();
const boxOf = soup => { const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity]; for (let i = 0; i < soup.length; i++) { const a = i % 3; if (soup[i] < lo[a]) lo[a] = soup[i]; if (soup[i] > hi[a]) hi[a] = soup[i]; } return { lo, hi }; };

const BOX_CLOSED = readStl(path.join(ROOT, 'library', 'box_closed.stl'));
const CAVITY_BOX = readStl(path.join(ROOT, 'fixtures', 'box_cavity_30.stl'));
const HINGE_HULL = readStl(path.join(ROOT, 'fixtures', 'features', 'feature-hull_hinge.stl'));

console.log('\n=== 1. box_closed ===');
{
  const a = SH.shells(BOX_CLOSED, { count: true });
  console.log('  reading: ' + a.shells.map(s => `shell ${s.id + 1}: ${s.tris} tris, closed ${s.closed}, vol ${s.vol.toFixed(0)}, crosses [${s.crosses.map(c => c + 1)}], insideOf ${s.insideOf === null ? 'null' : s.insideOf + 1}`).join(' | '));
  check('two shells, both closed', a.ok && a.n === 2 && a.shells.every(s => s.closed), a.words);
  check('each crosses the other, neither is inside anything', a.shells[0].crosses.join() === '1' && a.shells[1].crosses.join() === '0' && a.shells.every(s => s.insideOf === null));
  check('both are parts, not free (they cross), and Lift owns the piece', a.parts === 2 && a.shells.every(s => s.part && !s.free && s.liftable) && a.owned === true);
  const w = R._weldToIndexed(BOX_CLOSED, R.WELD_TOL), si = R._selfIntersectionDetail(w.mesh, { collect: true }), ov = R._overlapShells(w.mesh, si.pairs);
  check('NSO_Repair counts 74 piercing pairs, 10 truly crossing, 2 overlapping shells', si.pierce === 74 && ov.crossing === 10 && ov.overlapShells === 2, `${si.pierce} / ${ov.crossing} / ${ov.overlapShells}`);
  check('the classifier counts the same 10 crossing pairs', a.pairs === 10, String(a.pairs));
  check('without counting, the first crossing is enough (same answer, same shells)', JSON.stringify(SH.shells(BOX_CLOSED).shells.map(s => s.crosses)) === JSON.stringify(a.shells.map(s => s.crosses)));
}

console.log('\n=== 2. a hollow box ===');
{
  const a = SH.shells(CAVITY_BOX);
  console.log('  reading: ' + a.shells.map(s => `shell ${s.id + 1}: ${s.tris} tris, vol ${s.vol.toFixed(0)}, crosses [${s.crosses.map(c => c + 1)}], insideOf ${s.insideOf === null ? 'null' : s.insideOf + 1}`).join(' | '));
  check('two shells; the inner one is inside the outer, crosses nothing', a.n === 2 && a.shells[1].insideOf === 0 && a.shells.every(s => !s.crosses.length));
  check('one part: the cavity is not a part and is not liftable', a.parts === 1 && a.shells[0].part && !a.shells[1].part && !a.shells[1].liftable);
  check('Lift does not own it (a piece of one part lifts as it always did)', a.owned === false);
}

console.log('\n=== 3. the vase ===');
const VASE = SX.vase(), VASE_IN = SX.vase({ inward: true }), BODY = SX.vase({ handle: false });
{
  const a = SH.shells(VASE.soup, { count: true });
  console.log('  reading: ' + a.shells.map(s => `shell ${s.id + 1}: ${s.tris} tris, closed ${s.closed}, vol ${s.vol.toFixed(0)}, crosses [${s.crosses.map(c => c + 1)}], insideOf ${s.insideOf === null ? 'null' : s.insideOf + 1}`).join(' | '));
  check('body + handle: two closed shells that cross', a.n === 2 && a.shells.every(s => s.closed) && a.shells[0].crosses.join() === '1' && a.shells[1].crosses.join() === '0');
  check('the body is the big one, the handle the small one', a.shells[0].tris === VASE.bodyTris && a.shells[1].tris === VASE.handleTris);
  check('both parts; Lift owns it', a.parts === 2 && a.owned);
  const b = SH.shells(VASE_IN.soup);
  check('a handle wound inward reads the same: it crosses, so it is a part', b.shells[1].vol < 0 && b.shells[1].crosses.join() === '0' && b.parts === 2 && b.owned);
  const c = SH.shells(BODY.soup);
  check('a vase with no handle: one shell, one part, Lift does not own it', c.n === 1 && c.parts === 1 && !c.owned);
}

console.log('\n=== 4. a free second shell, and shells that interleave ===');
{
  const two = SX.twoBodies();
  const a = SH.shells(two.soup);
  check('a cube well apart from the body: two parts, both free and clear', a.n === 2 && a.parts === 2 && a.shells.every(s => s.free && s.clear), a.shells.map(s => s.clear).join());
  check('...and Lift owns it', a.owned);
  const h = SH.shells(HINGE_HULL);
  check('the print-in-place hinge: two parts that stand free but interleave - neither clear, Lift does NOT own it',
    h.n === 2 && h.parts === 2 && h.shells.every(s => s.free && !s.clear && !s.liftable) && h.owned === false);
  const cb = SH.shells(FX.captiveBall());
  check('a ball rattling in a cavity: the ball is inside the cavity shell, not a lifted shell; one body of three shells',
    cb.n === 3 && cb.shells.filter(s => s.insideOf !== null).length === 2 && cb.owned === false, cb.shells.map(s => s.insideOf).join());
}

console.log('\n=== 5. Split to parts ===');
{
  const sp = SP.split(BOX_CLOSED);
  check('box_closed -> 2 parts, 68 + 12 triangles', sp.ok && sp.parts.length === 2 && sp.parts.map(p => p.tris).join() === '68,12', sp.words + ' ' + sp.reason);
  check('...it says why: the shells cross', /2 shells cross another/.test(sp.reason), sp.reason);
  check('each part has no piercing pair (the whole had 74)', sp.parts.every(p => piercings(p.soup) === 0), sp.parts.map(p => piercings(p.soup)).join());
  const where = new Map();
  for (let t = 0; t < BOX_CLOSED.length / 9; t++) where.set(triKey(BOX_CLOSED, t), t);
  let bits = true, seen = new Set(), n = 0;
  for (const p of sp.parts) for (let t = 0; t < p.soup.length / 9; t++) { const at = where.get(triKey(p.soup, t)); if (at === undefined || seen.has(at)) bits = false; seen.add(at); n++; }
  check('every triangle bit for bit, once - so every part sits exactly where the whole drew it', bits && n === BOX_CLOSED.length / 9);
  const un = boxOf(Float32Array.from(sp.parts.flatMap(p => Array.from(p.soup))));
  const bo = boxOf(BOX_CLOSED);
  check('the parts\' boxes are the original\'s box', un.lo.every((v, k) => v === bo.lo[k]) && un.hi.every((v, k) => v === bo.hi[k]));
  check('the readout before the button: "2 parts"', SP.describe(sp) === '2 parts', SP.describe(sp));

  const v = SP.split(VASE.soup);
  check('the vase -> body + handle', v.ok && v.parts.length === 2 && v.parts.map(p => p.tris).sort((x, y) => y - x).join() === [VASE.bodyTris, VASE.handleTris].join(), v.parts.map(p => p.tris).join());
  const vi = SP.split(VASE_IN.soup);
  check('the vase with an inward handle -> body + handle too', vi.ok && vi.parts.length === 2 && vi.crossing === 2);

  for (const inward of [false, true]) {
    const pin = SP.split(SX.pinThrough(inward));
    check(`a pin through a block (${inward ? 'inward' : 'outward'}) -> 2 parts, both crossing, no hollow`, pin.ok && pin.parts.length === 2 && pin.crossing === 2 && pin.cavities === 0, pin.reason);
  }
  const free = SP.split(SX.twoBodies().soup);
  check('a piece with a free second shell (not touching) -> 2 parts, as it was', free.ok && free.parts.length === 2 && free.crossing === 0, free.reason);
  const one = SP.analyse(BODY.soup);
  check('a vase body alone -> 1 part, refused in words', !one.ok && one.words === '1 part' && /one shell/.test(one.reason), one.reason);
}

console.log('\n=== 6. nothing else changed ===');
{
  /* Recorded from nso_split_parts.js as it was before this ticket: the hash of the whole answer (faces, counts and
     the bytes of every part's soup) for every fixture with no crossing, and for box_closed. */
  const GOLD = {
    hollowBox: ['bbf3d2c0b3124ee1', FX.hollowBox()], looseCubes: ['02ac0223815a5313', FX.looseCubes()], touchingFace: ['a020e635557fd3a9', FX.touchingFace()],
    touchingEdge: ['8c662781ceabdb32', FX.touchingEdge()], touchingCorner: ['f92c68cfaf7b649c', FX.touchingCorner()], captiveBall: ['d8df7a995c5e83c9', FX.captiveBall()],
    hollowInCavity: ['66806b45e1191d85', FX.hollowInCavity()], hingeLifted: ['a7767118e62661f5', FX.hingeLifted().soup],
    box_cavity_30: ['bbf3d2c0b3124ee1', CAVITY_BOX], hinge_knuckle_box: ['7d8b6138e1ed6786', readStl(path.join(ROOT, 'fixtures', 'hinge_knuckle_box.stl'))],
    box_closed: ['18f309e0814b2001', BOX_CLOSED]
  };
  const hash = r => crypto.createHash('sha256').update(JSON.stringify({ ok: r.ok, words: r.words, shells: r.shells, cavities: r.cavities,
    parts: r.parts.map(p => ({ faces: p.faces, shells: p.shells, cavities: p.cavities, tris: p.tris, soup: p.soup ? Buffer.from(p.soup.buffer).toString('base64') : null })) })).digest('hex').slice(0, 16);
  for (const k of Object.keys(GOLD)) {
    const got = hash(SP.split(GOLD[k][1]));
    check(`${k}: byte-identical to the engine as it was`, got === GOLD[k][0], got);
  }
  const hb = SP.analyse(FX.hollowBox());
  check('a single shell with a true cavity: still "1 part", the same words as before', !hb.ok && hb.words === '1 part' &&
    hb.reason === 'Nothing to split - this piece is 1 part: it has 2 shells, but the other is a hollow inside it, not a part. Nothing changed.', hb.reason);
}

console.log('\n=== 7. the export check ===');
{
  const sp = SP.split(BOX_CLOSED);
  const named = SH.overlaps([{ name: 'box part 1', soup: sp.parts[0].soup }, { name: 'box part 2', soup: sp.parts[1].soup }]);
  check('the two halves, still laid through each other: one line, both named', named.pairs.length === 1 &&
    named.line === 'these pieces overlap; Join before printing: box part 1 + box part 2', named.line);
  const shift = (s, dx) => Float32Array.from(s, (x, i) => i % 3 === 0 ? x + dx : x);
  check('the same two apart: nothing', SH.overlaps([{ name: 'a', soup: sp.parts[0].soup }, { name: 'b', soup: shift(sp.parts[1].soup, 500) }]).line === '');
  const cubes = FX.touchingFace();
  const c1 = cubes.slice(0, 108), c2 = cubes.slice(108);
  check('two cubes that only touch face to face: nothing', SH.overlaps([{ name: 'a', soup: c1 }, { name: 'b', soup: c2 }]).line === '');
  const hb = FX.hollowBox();
  check('a small cube loose in a hollow box\'s cavity, touching nothing: nothing',
    SH.overlaps([{ name: 'box', soup: hb }, { name: 'ball', soup: Float32Array.from(FX.box(7, 7, 7, 4)) }]).line === '');
  const three = SH.overlaps([{ name: 'a', soup: BOX_CLOSED }, { name: 'b', soup: BOX_CLOSED }, { name: 'c', soup: shift(BOX_CLOSED, 900) }, { name: 'd', soup: shift(BOX_CLOSED, 900) }]);
  check('four pieces, two overlapping pairs: both pairs named in the one line', three.pairs.length === 2 && /a \+ b/.test(three.line) && /c \+ d/.test(three.line), three.line);
}

console.log('\n=== 8. a shell lifted out whole ===');
{
  const a = SH.shells(BOX_CLOSED);
  for (const s of a.shells) {
    const keep = []; for (let f = 0; f < a.tris; f++) if (a.of[f] !== s.id) keep.push(f);
    const out = SH.extract(BOX_CLOSED, s.faces), rest = SH.extract(BOX_CLOSED, keep);
    check(`shell ${s.id + 1} out and the rest: ${out.length / 9} + ${rest.length / 9} = ${a.tris} triangles, bit for bit, each closed`,
      out.length / 9 + rest.length / 9 === a.tris && SH.shells(out).n === 1 && SH.shells(out).shells[0].closed && SH.shells(rest).n === 1 && SH.shells(rest).shells[0].closed);
    check(`...and neither has a piercing pair (the box is left whole, the lid out intact)`, piercings(out) === 0 && piercings(rest) === 0);
  }
}

console.log('\n=== 9. timings ===');
{
  const t0 = Date.now(); SH.shells(VASE.soup); const small = Date.now() - t0;
  console.log(`  the small vase (${VASE.soup.length / 9} tris): ${small} ms`);
  check('the small vase reads in under 1 s', small < 1000, small + ' ms');
  if (process.env.NSO_SHELLS_BIG !== '0') {
    const big = SX.vase({ segs: 1200, rings: 300, nU: 600, nV: 60 });
    const t1 = Date.now(); const r = SH.shells(big.soup); const ms = Date.now() - t1;
    console.log(`  a ${(big.soup.length / 9 / 1e6).toFixed(2)} M-triangle vase: ${ms} ms`);
    check('the 1.5 M-triangle vase: body + handle found, in under 15 s', r.n === 2 && r.owned && ms < 15000, ms + ' ms');
  }
}

console.log('\n' + (C.fails ? C.fails + ' FAILED: ' + C.failed.join('; ') : 'all ' + C.passes + ' gates held'));
process.exit(C.fails ? 1 : 0);
