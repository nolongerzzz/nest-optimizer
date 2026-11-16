/* nso_feature_size.js - find one feature on a piece and size it, headless.
     node tools/nso_feature_size_test.js        exit 0 = every gate held

   On two pieces known by hand (tools/nso_feature_fixture.js): a 40 x 79 x 2
   plate with two 25 x 5 x 4 tongues on top, and a block with a 20 x 5.2 x 4
   slot down into it. Pinned:
   1. find(): a click on a tongue (its top, its side) is that tongue - raised,
      25 x 5 x 4, its foot on the plate's top, n up; a click on the slot's
      floor or wall is the slot - recessed, 20 x 5.2 x 4 deep; a click on the
      plate's big face is refused, in words (it is the piece).
   2. resize(), Keep ends: both tongues to 20.08 long (the fit the owner's
      scaled riser slots need) - each 20.08 x 5 x 4 about its own middle, the
      piece still closed and wound, the triangle count unchanged, nothing off
      the tongues moved but the plate face's corners at their feet; an eased
      tongue keeps its 45 degree ease exactly.
   3. Height and depth: a tongue 4 -> 6 tall, the slot 4 -> 2.5 deep; the
      foot never leaves its face.
   4. Stretch: every coordinate scaled about the middle (and the foot).
   5. Growing past the face's own corners: the face round the foot is laid
      again (refloored) and the piece is still closed; past the face's edge,
      refused in words.
   6. Refusals: under the Keep-ends floor (30%), a size of 0, two features
      that share a corner. */
const path = require('path');
const FS = require(path.join(__dirname, '..', 'nso_feature_size.js'));
const FX = require('./nso_feature_fixture.js');

let fails = 0;
const check = (name, cond, detail) => { console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail !== undefined ? ' - ' + detail : '')); if (!cond) fails++; };
const near = (a, b, t) => Math.abs(a - b) <= (t == null ? 1e-4 : t);

/* the first triangle whose centroid passes `test` */
function triWhere(s, test) {
  for (let f = 0; f < s.length / 9; f++) {
    const c = [0, 1, 2].map(a => (s[f * 9 + a] + s[f * 9 + 3 + a] + s[f * 9 + 6 + a]) / 3);
    if (test(c)) return f;
  }
  return -1;
}
function bounds(s, faces) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  faces.forEach(f => { for (let k = 0; k < 9; k++) { const a = k % 3, v = s[f * 9 + k]; if (v < lo[a]) lo[a] = v; if (v > hi[a]) hi[a] = v; } });
  return { lo, hi };
}

console.log('1. find');
const plate = FX.plateWithTongues();
check('fixture plate is closed and wound', FX.topology(plate).bad === 0 && FX.topology(plate).degenerate === 0, JSON.stringify(FX.topology(plate)));
const ix = FS.index(plate);
const tSouthTop = triWhere(plate, p => near(p[2], 6) && p[1] < 0);
const tNorthSide = triWhere(plate, p => near(p[0], 12.5) && p[1] > 0 && p[2] > 2);
const tPlate = triWhere(plate, p => near(p[2], 2) && Math.abs(p[1]) < 20);
const S = FS.find(plate, tSouthTop, { ix }), N = FS.find(plate, tNorthSide, { ix });
check('a click on a tongue top finds a raised feature', S.ok && S.kind === 'raised', S.reason);
check('it is 25 x 5 x 4', S.ok && near(S.frame.length, 25) && near(S.frame.width, 5) && near(S.frame.height, 4),
  S.ok && [S.frame.length, S.frame.width, S.frame.height].join(' x '));
check('its foot is on the plate top, n up, middle at (0, -33.5, 2)', S.ok && near(S.frame.n[2], 1) && near(S.frame.o[0], 0) && near(S.frame.o[1], -33.5) && near(S.frame.o[2], 2),
  S.ok && JSON.stringify(S.frame.o));
check('a tongue is its 6 faces: 4 walls and a top (10 triangles)', S.ok && S.faces.length === 10, S.ok && S.faces.length);
check('a click on the other tongue\'s side finds that tongue', N.ok && N.kind === 'raised' && near(N.frame.o[1], 33.5) && near(N.frame.length, 25), N.ok ? JSON.stringify(N.frame.o) : N.reason);
const P = FS.find(plate, tPlate, { ix });
check('a click on the plate\'s face is refused - it is the piece', !P.ok && /not a feature/.test(P.reason), P.reason);

const block = FX.blockWithSlot();
check('fixture block is closed and wound', FX.topology(block).bad === 0, JSON.stringify(FX.topology(block)));
const tFloor = triWhere(block, p => near(p[2], 6));
const tWall = triWhere(block, p => near(p[1], 2.6) && p[2] > 6 && p[2] < 10);
const SF = FS.find(block, tFloor), SW = FS.find(block, tWall);
check('a click on the slot floor finds a recess', SF.ok && SF.kind === 'recessed', SF.reason);
check('it is 20 x 5.2 x 4 deep', SF.ok && near(SF.frame.length, 20) && near(SF.frame.width, 5.2) && near(SF.frame.height, 4),
  SF.ok && [SF.frame.length, SF.frame.width, SF.frame.height].join(' x '));
check('its n points into the block (down)', SF.ok && near(SF.frame.n[2], -1));
check('a click on a slot wall finds the same recess', SW.ok && SW.kind === 'recessed' && SW.faces.length === SF.faces.length, SW.reason);

console.log('2. Keep ends: both tongues to 20.08');
const r1 = FS.resize(plate, [S, N], { length: 20.08 }, 'keep');
check('resized', r1.ok, r1.reason);
if (r1.ok) {
  const t = FX.topology(r1.soup);
  check('still closed and wound, no degenerate triangle', t.bad === 0 && t.degenerate === 0, JSON.stringify(t));
  check('the same triangles (no refloor needed to shrink)', r1.soup.length === plate.length && !r1.faceMap);
  check('both measure 20.08 x 5 x 4', r1.sizes.every(z => near(z.length, 20.08) && near(z.width, 5) && near(z.height, 4)), JSON.stringify(r1.sizes));
  const bS = bounds(r1.soup, S.faces), bN = bounds(r1.soup, N.faces);
  check('each about its own middle: x -10.04..10.04', near(bS.lo[0], -10.04) && near(bS.hi[0], 10.04) && near(bN.lo[0], -10.04) && near(bN.hi[0], 10.04));
  check('each stays on its own y', near(bS.lo[1], -36) && near(bS.hi[1], -31) && near(bN.lo[1], 31) && near(bN.hi[1], 36));
  let moved = 0, offFeature = 0;
  const onT = new Set(S.faces.concat(N.faces));
  for (let f = 0; f < plate.length / 9; f++) {
    let m = false;
    for (let k = 0; k < 9; k++) if (Math.abs(plate[f * 9 + k] - r1.soup[f * 9 + k]) > 1e-6) m = true;
    if (m) { moved++; if (!onT.has(f)) { for (let k = 0; k < 9; k += 3) if (!near(plate[f * 9 + k + 2], 2)) offFeature++; } }
  }
  check('off the tongues, only the plate top\'s corners at their feet moved', offFeature === 0, moved + ' triangles moved');
  check('volume down by 2 x 4.92 x 5 x 4', near(FX.volume(r1.soup), FX.volume(plate) - 2 * 4.92 * 5 * 4, 1e-2), FX.volume(r1.soup).toFixed(3));
}
const eased = FX.plateWithTongues({ ease: 0.4 });
const eS = FS.find(eased, triWhere(eased, p => near(p[2], 6) && p[1] < 0));
const r2 = FS.resize(eased, [eS], { length: 20 }, 'keep');
check('an eased tongue resizes', r2.ok, r2.reason);
if (r2.ok) {
  const b = bounds(r2.soup, eS.faces), topF = eS.faces.filter(f => [2, 5, 8].every(k => near(r2.soup[f * 9 + k], 6)));
  const bt = bounds(r2.soup, topF);
  check('its ease is still 0.4 at 45 degrees (top 19.2 on a 20 bar)', near(b.hi[0] - b.lo[0], 20) && near(bt.hi[0] - bt.lo[0], 19.2), (bt.hi[0] - bt.lo[0]).toFixed(4));
  check('still closed', FX.topology(r2.soup).bad === 0);
}

console.log('3. Height and depth');
const r3 = FS.resize(plate, [S], { height: 6 }, 'keep');
check('a tongue to 6 tall', r3.ok && near(r3.sizes[0].height, 6) && near(bounds(r3.soup, S.faces).hi[2], 8) && near(bounds(r3.soup, S.faces).lo[2], 2), r3.reason);
const r4 = FS.resize(block, [SF], { height: 2.5 }, 'keep');
check('the slot to 2.5 deep: floor at z 7.5, mouth still at 10', r4.ok && near(bounds(r4.soup, SF.faces).lo[2], 7.5) && near(bounds(r4.soup, SF.faces).hi[2], 10), r4.reason);
check('...closed', r4.ok && FX.topology(r4.soup).bad === 0);
const r4b = FS.resize(block, [SF], { length: 25.2 }, 'keep');
check('the slot to 25.2 long (the size it was before its piece was scaled)', r4b.ok && near(r4b.sizes[0].length, 25.2) && FX.topology(r4b.soup).bad === 0, r4b.reason);

console.log('4. Stretch');
const r5 = FS.resize(plate, [S], { length: 30, width: 6, height: 2 }, 'stretch');
check('stretched', r5.ok, r5.reason);
if (r5.ok) {
  const b = bounds(r5.soup, S.faces);
  check('30 x 6 x 2, about the middle and the foot', near(b.lo[0], -15) && near(b.hi[0], 15) && near(b.lo[1], -36.5) && near(b.hi[1], -30.5) && near(b.lo[2], 2) && near(b.hi[2], 4),
    JSON.stringify(b));
  check('...closed', FX.topology(r5.soup).bad === 0);
}

console.log('5. Growing past the face\'s corners');
/* a stray corner on the plate top 1.5 mm beyond a tongue's end, as a STEP
   export leaves them: the tongue grown past it folds the triangles fanned to it */
const stray = FX.plateWithTongues({ extra: [[14, -33.5]] });
const sS = FS.find(stray, triWhere(stray, p => near(p[2], 6) && p[1] < 0)), sN = FS.find(stray, triWhere(stray, p => near(p[2], 6) && p[1] > 0));
const r6 = FS.resize(stray, [sS, sN], { length: 34, width: 7 }, 'keep');
check('both tongues to 34 x 7 over the stray corner: the plate top is laid again', r6.ok && r6.refloored >= 1, r6.reason || ('refloored ' + r6.refloored));
if (r6.ok) {
  const t = FX.topology(r6.soup);
  check('closed and wound after the refloor', t.bad === 0 && t.degenerate === 0, JSON.stringify(t));
  check('both measure 34 x 7 x 4', r6.sizes.every(z => near(z.length, 34) && near(z.width, 7) && near(z.height, 4)), JSON.stringify(r6.sizes));
  check('volume up by 2 x (34 x 7 - 25 x 5) x 4', near(FX.volume(r6.soup), FX.volume(stray) + 2 * (34 * 7 - 125) * 4, 1e-2), FX.volume(r6.soup).toFixed(3));
}
const r6b = FS.resize(plate, [S, N], { length: 38, width: 8 }, 'keep');
check('38 x 8 on the clean plate: closed, the size asked', r6b.ok && FX.topology(r6b.soup).bad === 0 && r6b.sizes.every(z => near(z.length, 38) && near(z.width, 8)), r6b.reason);
const r7 = FS.resize(plate, [S], { length: 42 }, 'keep');
check('past the face\'s edge: refused in words', !r7.ok && /past the edge/.test(r7.reason), r7.reason);
const r7b = FS.resize(plate, [S, N], { width: 12 }, 'keep');
check('onto the face\'s edge (touching it): refused in words', !r7b.ok && /past the edge/.test(r7b.reason), r7b.reason);

console.log('6. Refusals');
const r8 = FS.resize(plate, [S], { length: 5 }, 'keep');
check('Keep ends will not go under 30%: says so, offers Stretch', !r8.ok && /7\.50/.test(r8.reason) && /Stretch/.test(r8.reason), r8.reason);
check('...Stretch goes there', FS.resize(plate, [S], { length: 5 }, 'stretch').ok);
check('a size of 0 is refused', !FS.resize(plate, [S], { width: 0 }, 'keep').ok);
check('the same feature twice is refused (they share corners)', !FS.resize(plate, [S, FS.find(plate, tSouthTop)], { length: 20 }, 'keep').ok);

console.log(fails ? '\nFAIL - ' + fails + ' gate(s)' : '\nall gates held');
process.exit(fails ? 1 : 0);
