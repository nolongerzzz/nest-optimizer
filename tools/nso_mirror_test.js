#!/usr/bin/env node
// Headless self-test for app-mirror.js (exact reflection across one plane).
//
//   node tools/nso_mirror_test.js        exit 0 = every gate held
//
// Loads the shipped files with vm so the browser files stay free of any node
// idiom, the same way tools/nso_extend_test.js does. app-extend.js is loaded
// because Mirror calls NSO_extendDetectAxis / NSO_extendBands and must not
// carry its own copy. app-cut.js is loaded for rawCut (the cut-band step).
// nso_planar_fuse.js is loaded for Align's shift and Join's fuse.
//
// app-finish.js is NOT loaded. That is the Soften module. The sequence section
// poisons rawEdgeRoundInPlace so a call into the round/bevel engine fails the
// run, and it asserts softenSelectedFace was never defined.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(__dirname, 'mirror-out');
const { readSTL, writeSTL } = require('./nso_stl_io.js');

const ctx = {
  Math, Map, Set, console, Array, Object, Number, String, JSON, isFinite, isNaN,
  parseFloat, parseInt, Float32Array, Float64Array, Int32Array, Uint32Array,
  Uint8Array, ArrayBuffer, Error, Infinity, NaN, Date, RegExp, Boolean
};
ctx.window = ctx;
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext('var state = {}; var THREE = {};', ctx);
for (const f of ['app-sculpt.js', 'app-extend.js', 'app-cut.js', 'app-mirror.js', 'nso_planar_fuse.js']) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
}
const {
  NSO_mirrorRaw, NSO_mirrorResolve, NSO_mirrorRoundTrips, NSO_mirrorReflectCoord,
  NSO_extendDetectAxis, NSO_extendBands, NSO_extendLengthToReach,
  NSO_fuseShift, NSO_fuseCandidateMatings, NSO_fuseFindMating, NSO_planarFusePair
} = ctx;

let pass = 0, fail = 0;
const FAILS = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok    ' + name + (detail ? '   ' + detail : '')); }
  else { fail++; FAILS.push(name); console.log('  FAIL  ' + name + (detail ? '   ' + detail : '')); }
}
const fx = f => readSTL(path.join(ROOT, f));

function box(sx, sy, sz, off) {
  const o = off || [0, 0, 0];
  const p = (i, j, k) => [o[0] + (i ? sx : 0), o[1] + (j ? sy : 0), o[2] + (k ? sz : 0)];
  const q = (a, b, c, d) => [a, b, c, a, c, d];
  const f = [
    q(p(0,0,0), p(0,1,0), p(1,1,0), p(1,0,0)), q(p(0,0,1), p(1,0,1), p(1,1,1), p(0,1,1)),
    q(p(0,0,0), p(1,0,0), p(1,0,1), p(0,0,1)), q(p(0,1,0), p(0,1,1), p(1,1,1), p(1,1,0)),
    q(p(0,0,0), p(0,0,1), p(0,1,1), p(0,1,0)), q(p(1,0,0), p(1,1,0), p(1,1,1), p(1,0,1))
  ].flat();
  return new Float32Array(f.flat());
}

function sortedCoord(soup, k) {
  const a = [];
  for (let i = k; i < soup.length; i += 3) a.push(soup[i]);
  a.sort((p, q) => p < q ? -1 : p > q ? 1 : 0);
  return a;
}
function sameList(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
function bounds(s) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < s.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      if (s[i + k] < lo[k]) lo[k] = s[i + k];
      if (s[i + k] > hi[k]) hi[k] = s[i + k];
    }
  }
  return { lo, hi };
}

/* Split a joined soup into the two sides of `plane` and reflect the max side
   back with the same Mirror. The two multisets of triangles are identical
   exactly when the ends are mirrors, winding included. */
function endIdentity(soup, axisIdx, plane) {
  const minTris = [], maxTris = [];
  let on = 0, straddle = 0;
  const n = soup.length / 9;
  for (let t = 0; t < n; t++) {
    const o = t * 9;
    let mn = Infinity, mx = -Infinity;
    for (let v = 0; v < 3; v++) {
      const c = soup[o + v * 3 + axisIdx];
      if (c < mn) mn = c;
      if (c > mx) mx = c;
    }
    const tri = soup.slice(o, o + 9);
    if (mn === plane && mx === plane) { on++; continue; }
    if (mn < plane && mx > plane) { straddle++; continue; }
    if (mx <= plane) minTris.push(tri);
    else maxTris.push(tri);
  }
  function soupFrom(tris) {
    const out = new Float32Array(tris.length * 9);
    for (let i = 0; i < tris.length; i++) out.set(tris[i], i * 9);
    return out;
  }
  const maxSoup = soupFrom(maxTris);
  const back = maxSoup.length ? NSO_mirrorRaw(maxSoup, { axis: axisIdx, plane: plane }) : { ok: true, tris: maxSoup };
  function bag(s) {
    const m = new Map();
    const count = s.length / 9;
    for (let t = 0; t < count; t++) {
      const key = Array.from(s.subarray(t * 9, t * 9 + 9)).join(',');
      m.set(key, (m.get(key) || 0) + 1);
    }
    return m;
  }
  const a = bag(soupFrom(minTris));
  const b = back.ok ? bag(back.tris) : new Map();
  let same = back.ok && a.size === b.size;
  if (same) {
    for (const [k, v] of a) if (b.get(k) !== v) { same = false; break; }
  }
  return { same, on, straddle, min: minTris.length, max: maxTris.length, backOk: back.ok, backReason: back.reason };
}

/* cut band → Mirror across that plane → Align (Join's own shift) → Join
   (Join's own mating search and fuse). No Soften symbol is called. */
function oppositeEnd(soup, label) {
  const det = NSO_extendDetectAxis(soup, {});
  if (!det.ok) return { ok: false, stage: 'axis', reason: det.reason, label };
  const bands = NSO_extendBands(soup, det.axisIdx, {});
  let plane, planeSource;
  if (bands.ok) { plane = bands.best.cut; planeSource = 'band'; }
  else {
    const span = NSO_extendLengthToReach(soup, det.axisIdx, 0);
    plane = (span.min + span.max) / 2;
    planeSource = 'midpoint';
  }
  /* keepMin false keeps coord <= plane (app-cut.js's clip sign). The low
     half, mirrored across the plane, lands on the high side. Join's mating
     search tries the +side candidate first, and that candidate is then the
     cut face at shift 0 — the same search a normal split uses. Mirroring the
     high half instead seats the twin on the low side, and the first candidate
     becomes the outer ends, which are also congruent on a prism. */
  let half;
  try { half = ctx.rawCut(soup, det.axisIdx, plane, false); }
  catch (e) { return { ok: false, stage: 'cut', reason: e.message, label, plane, planeSource, det, bands }; }
  if (!half || half.length < 9) {
    return { ok: false, stage: 'cut', reason: 'cut kept nothing', label, plane, planeSource, det, bands };
  }
  const mir = NSO_mirrorRaw(half, { axis: det.axis, plane: plane });
  if (!mir.ok) {
    return { ok: false, stage: 'mirror', reason: mir.reason, label, plane, planeSource, det, bands, half };
  }
  /* Align, in raw space, is the shift Join's mating search would apply.
     Two candidates sit on the cut axis (B on the + side of A, or the − side).
     The mirror of a cut half lands on the empty side, already flush, so the
     nearer one has shift 0. Picking that one is the whole of Align. */
  const onAxis = NSO_fuseCandidateMatings(half, mir.tris)
    .filter(c => c.axis === det.axisIdx)
    .sort((a, b) => Math.abs(a.shift) - Math.abs(b.shift));
  const align = onAxis[0];
  const aligned = NSO_fuseShift(mir.tris, det.axisIdx, align ? align.shift : NaN);
  /* Join the faces Align left coincident. NSO_findSharedFace is the
     congruence test inside Join; it does not get a Mirror option. The
     parked-apart search (NSO_fuseFindMating) is recorded too, because on a
     cut that is not a clean band it can accept a different pair. */
  const found = ctx.NSO_findSharedFace(half, aligned);
  const parked = NSO_fuseFindMating(half, aligned);
  if (!found.ok) {
    return { ok: false, stage: 'join', reason: found.reason, label, plane, planeSource,
             det, bands, half, mir, alignShift: align && align.shift, found, parked };
  }
  const fused = NSO_planarFusePair(half, aligned, { found: found });
  const ends = fused.ok ? endIdentity(fused.soup, det.axisIdx, plane) : null;
  return {
    ok: !!(fused.ok && ends && ends.same), label, plane, planeSource, det, bands,
    half, mir, alignShift: align && align.shift, found, parked, fused, ends,
    stage: fused.ok ? 'done' : 'join-fuse', reason: fused.reason
  };
}

fs.mkdirSync(OUT, { recursive: true });

console.log('\n=== 1. the axis is Extend\'s detector, called, not copied ===');
{
  const src = fs.readFileSync(path.join(ROOT, 'app-mirror.js'), 'utf8');
  check('app-mirror.js calls NSO_extendDetectAxis', /NSO_extendDetectAxis\(/.test(src));
  check('and does not declare its own axis census', !/function NSO_mirrorAxisCensus|function NSO_extendDetectAxis/.test(src));
  check('Soften is not called from this file',
    !/softenSelectedFace|rawPerimeterFilletInPlace|rawEdgeRoundInPlace|rawChamferCut/.test(src));
  check('Align and Join are not called from this file',
    !/NSO_fuseFindMating|NSO_planarFusePair|alignJoinForSlide|rawJoinPieces/.test(src));

  const strap = fx('fixtures/lid_strap.stl');
  const d = NSO_extendDetectAxis(strap, {});
  const r = NSO_mirrorResolve(strap, {});
  check('lid_strap resolves on Extend\'s axis', r.ok && r.axis === d.axis && r.axis === 'x',
    r.ok ? r.axis + ' plane ' + r.plane + ' (' + r.planeSource + ')' : r.reason);
  check('the default plane is the clean-band cut', r.ok && r.planeSource === 'band' && r.plane === 30, String(r.plane));

  const cube = box(20, 20, 20);
  const cd = NSO_extendDetectAxis(cube, {});
  const cr = NSO_mirrorResolve(cube, {});
  check('a cube is refused in Extend\'s own words',
    !cr.ok && !cd.ok && cr.reason === cd.reason && /no single dominant axis/.test(cr.reason),
    cr.reason);
  const forced = NSO_mirrorRaw(cube, { axis: 'x', plane: 0 });
  check('opts.axis forces the axis the way Extend\'s does', forced.ok && forced.axis === 'x',
    forced.ok ? 'plane ' + forced.plane : forced.reason);

  const sphere = fx('fixtures/fixture_sphere_curved.stl');
  const sd = NSO_extendDetectAxis(sphere, {});
  const sr = NSO_mirrorResolve(sphere, {});
  check('a curved piece is refused in Extend\'s own words',
    !sr.ok && sr.reason === sd.reason && /no dominant straight axis/.test(sr.reason), sr.reason);
}

console.log('\n=== 2. X→−X is exact, and the other two axes are untouched ===');
{
  const strap = fx('fixtures/lid_strap.stl');
  const before = new Float32Array(strap);
  const r = NSO_mirrorRaw(strap, { plane: 0 });
  check('accepted across plane 0', r.ok, r.ok ? r.axis + ' source ' + r.planeSource : r.reason);
  if (r.ok) {
    check('cross-section drift is exactly 0 coordinates', r.crossSectionDrift === 0);
    check('input soup was not mutated', sameList(sortedCoord(strap, 0), sortedCoord(before, 0)) &&
      strap.length === before.length && strap[0] === before[0] && strap[1] === before[1]);
    const y0 = sortedCoord(before, 1), z0 = sortedCoord(before, 2);
    check('every Y coordinate is still in the soup', sameList(sortedCoord(r.tris, 1), y0));
    check('every Z coordinate is still in the soup', sameList(sortedCoord(r.tris, 2), z0));
    const xb = bounds(before), xa = bounds(r.tris);
    check('X negated: 0..60 became -60..0',
      xa.lo[0] === -xb.hi[0] && xa.hi[0] === -xb.lo[0],
      xa.lo[0] + '..' + xa.hi[0]);
    check('triangle count unchanged', r.tris.length === strap.length);
    check('volume stayed positive and the same magnitude',
      r.volumeAfter > 0 && r.volumeAfter === r.volumeBefore,
      r.volumeBefore + ' → ' + r.volumeAfter);
    const again = NSO_mirrorRaw(r.tris, { plane: 0 });
    let identical = again.ok && again.tris.length === before.length;
    if (identical) for (let i = 0; i < before.length; i++) if (again.tris[i] !== before[i]) { identical = false; break; }
    check('mirroring twice restores the soup bit for bit', identical);
  }

  const pin = fx('fixtures/pin.stl');
  const pinR = NSO_mirrorRaw(pin, { plane: 0 });
  check('pin.stl across 0 is exact', pinR.ok && pinR.crossSectionDrift === 0, pinR.reason);
  const pin2 = pinR.ok && NSO_mirrorRaw(pinR.tris, { plane: 0 });
  let pinSame = !!(pin2 && pin2.ok);
  if (pinSame) for (let i = 0; i < pin.length; i++) if (pin2.tris[i] !== pin[i]) { pinSame = false; break; }
  check('pin.stl mirrored twice is the original soup', pinSame);
}

console.log('\n=== 3. a plane that does not round-trip is a refusal ===');
{
  /* 0 and 1 are exact float32s. 0.1 is not a midpoint any float32 reflection
     of both of them can land on: fround(0.2 - 0) does not reflect back to 0. */
  const unit = box(1, 1, 1);
  const trip = NSO_mirrorRoundTrips(unit, 0, 0.1);
  check('plane 0.1 on a 0..1 box fails the round-trip', !trip.ok,
    'misses ' + trip.misses + ' worst ' + trip.worst.toExponential(2));
  const r = NSO_mirrorRaw(unit, { axis: 'x', plane: 0.1 });
  check('Mirror refuses it and names float32', !r.ok && /exact float32 mirror plane/.test(r.reason), r.reason);
  check('and hands back the original soup object', r.tris === unit);
  const zero = NSO_mirrorRaw(unit, { axis: 'x', plane: 0 });
  check('the same box across 0 is accepted', zero.ok && zero.crossSectionDrift === 0 && zero.volumeAfter === zero.volumeBefore,
    zero.ok ? String(zero.volumeAfter) : zero.reason);
}

console.log('\n=== 4. cut band → Mirror → Align → Join, with no Soften ===');
{
  check('softenSelectedFace is not loaded', typeof ctx.softenSelectedFace !== 'function');
  check('rawPerimeterFilletInPlace is not loaded', typeof ctx.rawPerimeterFilletInPlace !== 'function');
  let softenCalled = false;
  ctx.rawEdgeRoundInPlace = function () { softenCalled = true; throw new Error('Soften engine was called'); };

  const slot = fx('library/soften_test_04_slotted_block.stl');
  const seq = oppositeEnd(slot, 'slotted block');
  console.log('   slotted block: plane ' + seq.plane + ' (' + seq.planeSource + ')' +
    (seq.fused && seq.fused.ok
      ? '  fuse ' + seq.fused.stats.triIn + '→' + seq.fused.stats.triOut +
        ' tris, snapped ' + seq.fused.stats.vertsSnapped
      : '  stopped at ' + seq.stage + ': ' + seq.reason));
  check('the cut plane is the clean band, not a fallback', seq.planeSource === 'band' && seq.plane === 20,
    seq.planeSource + ' ' + seq.plane);
  check('Mirror\'s cross-section drift on the cut half is 0',
    seq.mir && seq.mir.crossSectionDrift === 0);
  check('Align\'s shift is 0 — the mirror already sits on the cut plane',
    seq.alignShift === 0, 'shift ' + seq.alignShift);
  check('Join\'s coincident-face test accepts the cut, and its parked search agrees',
    seq.found && seq.found.ok && seq.parked && seq.parked.ok &&
    seq.parked.axis === seq.det.axisIdx && seq.parked.shift === 0 && seq.parked.tried === 1,
    seq.parked ? ('axis ' + seq.parked.axis + ' shift ' + seq.parked.shift + ' tried ' + seq.parked.tried) : seq.reason);
  check('Join welds it as an ordinary pair', seq.fused && seq.fused.ok, seq.reason);
  check('Join snapped 0 seam vertices — the mirror\'s cap already matched',
    seq.fused && seq.fused.ok && seq.fused.stats.vertsSnapped === 0,
    seq.fused && seq.fused.ok ? String(seq.fused.stats.vertsSnapped) : '');
  check('the two ends are the same triangles after reflecting one back',
    seq.ends && seq.ends.same && seq.ends.on === 0 && seq.ends.straddle === 0,
    seq.ends ? ('min ' + seq.ends.min + ' max ' + seq.ends.max + ' on-plane ' + seq.ends.on +
      ' straddle ' + seq.ends.straddle) : '');
  check('the round/bevel engine was not called', !softenCalled);
  if (seq.fused && seq.fused.ok) {
    writeSTL(path.join(OUT, 'slotted_joined.stl'), seq.fused.soup, 'mirror sequence slotted block');
    fs.writeFileSync(path.join(OUT, 'slotted_joined.json'), JSON.stringify({
      axis: seq.det.axis, axisIdx: seq.det.axisIdx, plane: seq.plane, planeSource: seq.planeSource,
      ends: seq.ends, snapped: seq.fused.stats.vertsSnapped, alignShift: seq.alignShift
    }));
  }

  console.log('\n   v8_FINAL tape — clean-band scan, then the same sequence');
  const tape = fx('fixtures/tape_on-edge-single-B101_rounded_v8_FINAL.stl');
  const tapeDet = NSO_extendDetectAxis(tape, {});
  const tapeBands = tapeDet.ok ? NSO_extendBands(tape, tapeDet.axisIdx, {}) : { ok: false, reason: tapeDet.reason };
  check('v8_FINAL detects a dominant axis', tapeDet.ok && tapeDet.axis === 'x', tapeDet.ok ? tapeDet.axis : tapeDet.reason);
  check('v8_FINAL has no clean band — Extend\'s scan refuses, and Mirror does not weaken it',
    !tapeBands.ok && /no constant cross-section band/.test(tapeBands.reason),
    tapeBands.ok ? 'unexpected clean band at ' + tapeBands.best.cut : tapeBands.reason.slice(0, 140));
  const tapeSeq = oppositeEnd(tape, 'v8_FINAL');
  console.log('   v8 sequence: plane ' + tapeSeq.plane + ' (' + tapeSeq.planeSource + ')' +
    (tapeSeq.fused && tapeSeq.fused.ok
      ? '  fuse ' + tapeSeq.fused.stats.triIn + '→' + tapeSeq.fused.stats.triOut +
        ' tris, snapped ' + tapeSeq.fused.stats.vertsSnapped +
        '  ends min ' + (tapeSeq.ends ? tapeSeq.ends.min : '?') + ' max ' + (tapeSeq.ends ? tapeSeq.ends.max : '?')
      : '  stopped at ' + tapeSeq.stage + ': ' + tapeSeq.reason));
  check('v8 sequence mirrors across the midpoint fallback', tapeSeq.planeSource === 'midpoint', tapeSeq.planeSource);
  check('v8 Align shift is 0', tapeSeq.alignShift === 0, 'shift ' + tapeSeq.alignShift);
  check('v8 the mirrored half is the exact mirror of the cut half',
    tapeSeq.mir && tapeSeq.mir.ok && tapeSeq.mir.crossSectionDrift === 0);
  let tapeBackSame = false;
  if (tapeSeq.mir && tapeSeq.mir.ok) {
    const back = NSO_mirrorRaw(tapeSeq.mir.tris, { axis: tapeSeq.det.axis, plane: tapeSeq.plane });
    tapeBackSame = back.ok && back.tris.length === tapeSeq.half.length;
    if (tapeBackSame) for (let i = 0; i < tapeSeq.half.length; i++) if (back.tris[i] !== tapeSeq.half[i]) { tapeBackSame = false; break; }
  }
  check('v8 mirroring the twin again restores the cut half bit for bit', tapeBackSame);
  check('v8 Join refuses the cut face on its own tolerance rail — the cut is not a clean band',
    tapeSeq.stage === 'join' && /too coarse for this face/.test(tapeSeq.reason), tapeSeq.reason);
  check('v8 the parked-apart search would take a different pair, so the sequence does not use it',
    tapeSeq.parked && tapeSeq.parked.ok && tapeSeq.parked.shift !== 0,
    tapeSeq.parked ? ('shift ' + tapeSeq.parked.shift + ' tried ' + tapeSeq.parked.tried) : 'no parked result');
  if (tapeSeq.half && tapeSeq.mir && tapeSeq.mir.ok) {
    writeSTL(path.join(OUT, 'v8_half.stl'), tapeSeq.half, 'v8 low half at midpoint');
    writeSTL(path.join(OUT, 'v8_mirror.stl'), tapeSeq.mir.tris, 'v8 mirror of that half');
    fs.writeFileSync(path.join(OUT, 'v8_joined.json'), JSON.stringify({
      axis: tapeSeq.det.axis, axisIdx: tapeSeq.det.axisIdx, plane: tapeSeq.plane,
      planeSource: tapeSeq.planeSource, cleanBand: false,
      joinRefused: tapeSeq.reason, parkedShift: tapeSeq.parked && tapeSeq.parked.shift,
      exactMirror: tapeBackSame
    }));
  }
  check('Soften still was not called', !softenCalled);
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
if (fail) { console.log('failing:'); for (const f of FAILS) console.log('  - ' + f); }
process.exit(fail === 0 ? 0 : 1);
