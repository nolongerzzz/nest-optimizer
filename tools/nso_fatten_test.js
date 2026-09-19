#!/usr/bin/env node
// Headless self-test for app-fatten.js (cross-section grow / shrink).
//
//   node tools/nso_fatten_test.js        exit 0 = every gate held
//
// Loads the shipped files with vm, the same way tools/nso_extend_test.js does,
// in index.html's own order: app-sculpt.js, app-finish.js, app-extend.js,
// app-fatten.js. app-finish.js touches `window` at the bottom, so the context
// carries a stub for it - nothing else about the file is altered, and the
// functions under test are the ones the browser runs.
//
// Three things are being proved, and the third is the one that matters most:
//
//   1. FATTEN DOES ITS JOB. The cross-section moves by the asked offset and
//      the axis extent does not move at all - measured, not rounded.
//   2. FATTEN REFUSES WHAT EXTEND REFUSES. Same detector, same words.
//   3. THICKEN IS UNCHANGED. Section D re-runs Thicken with no options at all
//      and compares the output buffer against a baseline captured from the
//      same call, coordinate by coordinate, on tube and NON-TUBE geometry
//      alike - a sphere, a blob, an open box, a cube. This is strictly
//      additive or it is a fork, and section D is what tells the difference.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const { readSTL } = require('./nso_stl_io.js');

const ctx = {
  Math, Map, Set, console, Array, Object, Number, String, JSON, isFinite, isNaN,
  parseFloat, parseInt, Float32Array, Float64Array, Int32Array, Uint32Array,
  Uint8Array, Uint16Array, ArrayBuffer, Error, Infinity, NaN, Date, Promise,
  RegExp, Boolean, Symbol, setTimeout, clearTimeout
};
ctx.window = ctx;
ctx.globalThis = ctx;
vm.createContext(ctx);
for (const f of ['app-sculpt.js', 'app-finish.js', 'app-extend.js', 'app-fatten.js']) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
}
const {
  NSO_fattenCrossSectionFaces, NSO_fattenLengthGate,
  NSO_extendDetectAxis, NSO_extendLengthToReach,
  _thickenOffsetSoup
} = ctx;

let pass = 0, fail = 0;
const FAILS = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok    ' + name + (detail ? '   ' + detail : '')); }
  else { fail++; FAILS.push(name); console.log('  FAIL  ' + name + (detail ? '   ' + detail : '')); }
}
const fx = f => readSTL(path.join(ROOT, 'fixtures', f));

function bbox(t) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < t.length; i += 3) for (let c = 0; c < 3; c++) {
    const v = t[i + c];
    if (v < lo[c]) lo[c] = v;
    if (v > hi[c]) hi[c] = v;
  }
  return { lo, hi, size: [0, 1, 2].map(c => hi[c] - lo[c]) };
}
const fmt = a => a.map(v => v.toFixed(4)).join(' x ');

/* The headless half of NSO_fattenSelectedModel: everything except getActiveModel,
   the paint check and the commit. Same two calls in the same order, so what is
   exercised here is what the button runs. */
function fattenRaw(soup, dir, mm, opts) {
  opts = opts || {};
  const det = NSO_extendDetectAxis(soup, opts);
  if (!det.ok) return { ok: false, reason: det.reason, detect: det };
  const faces = NSO_fattenCrossSectionFaces(soup, det.axisIdx, opts);
  if (faces.move === 0) return { ok: false, reason: 'no face is parallel to ' + det.axis, faces, detect: det };
  const r = _thickenOffsetSoup(soup, 'out', dir === 'shrink' ? -mm : +mm, { mayMove: faces.mayMove });
  if (!r || !r.soup) return { ok: false, reason: (r && r.reason) || 'no soup', faces, detect: det };
  const why = NSO_fattenLengthGate(det.axisIdx, opts.lengthUlps)(soup, r.soup);
  if (why) return { ok: false, reason: why, faces, detect: det };
  return { ok: true, tris: r.soup, faces, detect: det, axisIdx: det.axisIdx, axis: det.axis, offset: r };
}

/* ======================================================================
   A. A round tube: the cross-section moves, the length does not
   ====================================================================== */
console.log('\n== A. cylinder r10 h30 along Z: grow and shrink the cross-section ==');
{
  const soup = fx('cylinder_r10h30_s64.stl');
  const b0 = bbox(soup);
  check('Extend’s detector calls it Z, and Fatten takes that verbatim',
        NSO_extendDetectAxis(soup, {}).axis === 'z', 'bbox ' + fmt(b0.size));

  const faces = NSO_fattenCrossSectionFaces(soup, 2, {});
  // 64 segments: 128 side triangles and 64 per cap. The side wall is the whole
  // of the movable set and the two caps are the whole of the held one.
  check('the side wall is marked movable and the two caps are not',
        faces.move === 128 && faces.hold === 128 && faces.untrusted === 0,
        'move ' + faces.move + ', hold ' + faces.hold + ', worst |n.u| on a moving face ' +
        faces.worstAlong.toExponential(2));

  for (const [dir, mm, want] of [['grow', 1, 1], ['shrink', 1, -1], ['grow', 0.25, 0.25]]) {
    const r = fattenRaw(soup, dir, mm);
    check('fatten ' + dir + ' ' + mm + ' succeeds', r.ok, r.ok ? '' : r.reason);
    if (!r.ok) continue;
    const b1 = bbox(r.tris);
    const dz = b1.size[2] - b0.size[2];
    check('  ...Z length is held EXACTLY - ' + b0.size[2].toFixed(4) + ' mm in, ' + b1.size[2].toFixed(4) + ' mm out',
          dz === 0, 'drift ' + dz);
    check('  ...and the two caps are still exactly where they were',
          b1.lo[2] === b0.lo[2] && b1.hi[2] === b0.hi[2]);
    check('  ...diameter moves by 2 x ' + want + ' mm on both cross-section axes',
          Math.abs((b1.size[0] - b0.size[0]) - 2 * want) < 2e-3 &&
          Math.abs((b1.size[1] - b0.size[1]) - 2 * want) < 2e-3,
          fmt(b0.size) + '  →  ' + fmt(b1.size));
    check('  ...triangle count unchanged - nothing re-tessellated',
          r.tris.length === soup.length, soup.length / 9 + ' triangles');
  }
}

/* ======================================================================
   B. The same piece through plain Thicken: what Fatten is FOR
   ====================================================================== */
console.log('\n== B. why the axis restriction is the whole feature ==');
{
  const soup = fx('cylinder_r10h30_s64.stl');
  const b0 = bbox(soup);
  const plain = _thickenOffsetSoup(soup, 'out', 1);
  const bP = bbox(plain.soup);
  check('plain Thicken out 1.0 grows the LENGTH too - 30 → ' + bP.size[2].toFixed(4) + ' mm',
        Math.abs(bP.size[2] - 32) < 1e-3, fmt(b0.size) + '  →  ' + fmt(bP.size));
  const r = fattenRaw(soup, 'grow', 1);
  const bF = bbox(r.tris);
  check('Fatten grow 1.0 reaches the same diameter and holds the length',
        Math.abs(bF.size[0] - bP.size[0]) < 2e-3 && bF.size[2] === b0.size[2],
        'fatten ' + fmt(bF.size));
  check('the two differ ONLY along the axis - it is one offset, restricted',
        Math.abs(bF.size[0] - bP.size[0]) < 2e-3 && Math.abs(bF.size[1] - bP.size[1]) < 2e-3);
}

/* ======================================================================
   C. Other shapes in scope, and the refusals
   ====================================================================== */
console.log('\n== C. an 8-sided prism, a pin with end chamfers, a flat strap ==');
{
  const soup = fx('prism_r10h30_s8.stl');
  const b0 = bbox(soup);
  const r = fattenRaw(soup, 'grow', 0.5);
  check('prism r10 h30 s8: fatten grow 0.5 succeeds on a faceted section', r.ok, r.ok ? '' : r.reason);
  if (r.ok) {
    const b1 = bbox(r.tris);
    check('  ...Z held exactly, cross-section grew', b1.size[2] === b0.size[2] && b1.size[0] > b0.size[0],
          fmt(b0.size) + '  →  ' + fmt(b1.size));
  }
}
{
  // pin.stl is Extend's own "the ticket's premise was off" fixture: its X
  // layers are 0, 0.1, 19.9, 20, so it carries 0.1 mm END chamfers and not a
  // taper. Those chamfers are oblique to X, so Fatten HOLDS them, and what the
  // holding buys is asymmetric in a way worth knowing:
  //
  //   GROW   the shaft/chamfer ring slides outward along the held chamfer,
  //          into 19.8 mm of shaft. Nothing to run into, so it goes through at
  //          any size the shaft can carry - and X stays 20 mm, where plain
  //          Thicken out 0.5 would have taken it to 21.
  //   SHRINK the same ring slides toward the END, and has only the chamfer's
  //          own 0.1 mm to slide along. A shrink bigger than that turns the
  //          chamfer inside out and is refused - the inherited inversion gate
  //          reading the chamfer as the feature being eaten, which is the same
  //          verdict plain Thicken gives, by a different route, at a
  //          comparable size.
  //
  // So holding a small end chamfer is not a way round the safety gate. It is a
  // way to keep the chamfer's angle and width when the offset does fit.
  const soup = fx('pin.stl');
  const b0 = bbox(soup);
  const faces = NSO_fattenCrossSectionFaces(soup, 0, {});
  check('pin.stl: 128 chamfer + 64 cap faces held, the 64 shaft-wall faces move',
        faces.move === 64 && faces.hold === 192 && faces.untrusted === 0,
        'move ' + faces.move + ', hold ' + faces.hold + ' of ' + soup.length / 9);

  const plainUp = _thickenOffsetSoup(soup, 'out', 0.5);
  check('plain Thicken out 0.5 takes pin.stl to ' + bbox(plainUp.soup).size[0].toFixed(4) + ' mm long',
        Math.abs(bbox(plainUp.soup).size[0] - 21) < 1e-3, fmt(bbox(plainUp.soup).size));
  const up = fattenRaw(soup, 'grow', 0.5);
  check('Fatten grow 0.5 reaches the same section and leaves the length at 20', up.ok, up.ok ? '' : up.reason);
  if (up.ok) {
    const b1 = bbox(up.tris);
    check('  ...X held exactly at ' + b0.size[0].toFixed(4) + ' mm, both chamfers carried along',
          b1.size[0] === b0.size[0], fmt(b0.size) + '  ->  ' + fmt(b1.size));
    check('  ...the 3 mm section grew by 2 x 0.5 mm',
          Math.abs((b1.size[1] - b0.size[1]) - 1) < 5e-3 &&
          Math.abs((b1.size[2] - b0.size[2]) - 1) < 5e-3);
  }

  const plainDown = _thickenOffsetSoup(soup, 'out', -0.5);
  check('plain Thicken out -0.5 refuses pin.stl - it eats the 0.1 mm chamfers',
        !plainDown.soup && /turn inside out/.test(plainDown.reason || ''), plainDown.reason);
  const tooFar = fattenRaw(soup, 'shrink', 0.2);
  check('Fatten shrink 0.2 is refused as well - 0.2 mm is more chamfer than there is',
        !tooFar.ok && /turn inside out/.test(tooFar.reason), tooFar.reason);
  // The ring slide itself, in numbers, because docs/FATTEN.md quotes them: the
  // chamfer/shaft ring leaves x = 0.1 and the two end layers do not move.
  if (up.ok) {
    const layer = a => { const s2 = new Set(); for (let i = 0; i < a.length; i += 3) s2.add(a[i]); return [...s2].sort((p2, q2) => p2 - q2); };
    const L0 = layer(soup), L1 = layer(up.tris);
    check('  ...the end layers 0 and 20 are untouched; the 0.1 mm ring slid outward along the held chamfer',
          L0[0] === L1[0] && L0[L0.length - 1] === L1[L1.length - 1] &&
          L1.indexOf(0.1) === -1 && L1[1] > 0.5 && L1[1] < 0.7,
          'x layers in [' + L0.map(v => v.toFixed(4)).join(', ') + '], first interior out ' + L1[1].toFixed(5));
  }

  const fits = fattenRaw(soup, 'shrink', 0.1);
  check('Fatten shrink 0.1 - exactly the chamfer width - goes through', fits.ok, fits.ok ? '' : fits.reason);
  if (fits.ok) {
    const b1 = bbox(fits.tris);
    check('  ...X held exactly, section in by 2 x 0.1 mm',
          b1.size[0] === b0.size[0] && Math.abs((b0.size[1] - b1.size[1]) - 0.2) < 5e-3,
          fmt(b0.size) + '  ->  ' + fmt(b1.size));
  }
}
{
  const soup = fx('lid_strap.stl');
  const b0 = bbox(soup);
  const r = fattenRaw(soup, 'grow', 0.4);
  check('lid_strap.stl (60 x 48 x 2.4, X dominant): grow 0.4 succeeds', r.ok, r.ok ? '' : r.reason);
  if (r.ok) check('  ...X held exactly', bbox(r.tris).size[0] === b0.size[0],
                  fmt(b0.size) + '  →  ' + fmt(bbox(r.tris).size));
}

console.log('\n== C2. out of scope, refused by name - Extend’s scope verbatim ==');
{
  const sphere = fattenRaw(fx('fixture_sphere_curved.stl'), 'grow', 0.5);
  check('a sphere is refused: no dominant straight axis',
        !sphere.ok && /no dominant straight axis/.test(sphere.reason), sphere.reason);
  const blob = fattenRaw(fx('fixture_blob_organic.stl'), 'grow', 0.5);
  check('an organic blob is refused for the same reason',
        !blob.ok && /no dominant straight axis/.test(blob.reason), blob.reason);
  const cube = fattenRaw(fx('box-20mm.stl'), 'grow', 0.5);
  check('a 20 mm cube is refused: straight three ways, so which did you mean?',
        !cube.ok && /no single dominant axis/.test(cube.reason), cube.reason);
  const forced = fattenRaw(fx('box-20mm.stl'), 'grow', 0.5, { axis: 'z' });
  check('  ...and opts.axis answers that question, as it does for Extend',
        forced.ok && bbox(forced.tris).size[2] === 20,
        forced.ok ? fmt(bbox(forced.tris).size) : forced.reason);
}
{
  // An off-cardinal piece: the same cylinder rotated 20 degrees about Y.
  const src = fx('cylinder_r10h30_s64.stl');
  const rot = new Float32Array(src.length);
  const a = 20 * Math.PI / 180, ca = Math.cos(a), sa = Math.sin(a);
  for (let i = 0; i < src.length; i += 3) {
    rot[i] = ca * src[i] + sa * src[i + 2];
    rot[i + 1] = src[i + 1];
    rot[i + 2] = -sa * src[i] + ca * src[i + 2];
  }
  const r = fattenRaw(rot, 'grow', 0.5);
  check('a cylinder tilted 20 deg off Z is refused, not quietly offset',
        !r.ok && /off-cardinal|no dominant straight axis/.test(r.reason), r.reason);
}
{
  // An honest taper: a truncated cone along X. Extend's own refusal fixture.
  const seg = 48, len = 30, r0 = 10, r1 = 4, t = [];
  const ring = (x, r) => Array.from({ length: seg }, (_, i) => {
    const th = 2 * Math.PI * i / seg;
    return [x, r * Math.cos(th), r * Math.sin(th)];
  });
  const A = ring(0, r0), B = ring(len, r1);
  for (let i = 0; i < seg; i++) {
    const j = (i + 1) % seg;
    t.push(A[i], B[i], B[j]); t.push(A[i], B[j], A[j]);
    t.push([0, 0, 0], A[j], A[i]); t.push([len, 0, 0], B[i], B[j]);
  }
  const cone = new Float32Array(t.flat());
  const r = fattenRaw(cone, 'grow', 0.5);
  check('a cone is refused - a taper has no constant cross-section to grow',
        !r.ok, r.reason);
}
{
  // Shrink further than the wall it eats: the inversion gate, inherited whole.
  const soup = fx('cylinder_r10h30_s64.stl');
  const r = fattenRaw(soup, 'shrink', 11);
  check('shrink 11 mm off a 10 mm radius is refused by Thicken’s inversion gate',
        !r.ok && /turn inside out|more than the feature/.test(r.reason), r.reason);
}

/* ======================================================================
   D. THICKEN IS UNCHANGED. The point of the whole exercise.
   ====================================================================== */
console.log('\n== D. regression: Thicken with no options is bit-identical, tube and non-tube ==');
{
  // The baseline is the same function called the way every shipped caller
  // calls it - two arguments. If the opts channel had leaked into the default
  // path, these would differ.
  const cases = [
    ['cylinder_r10h30_s64.stl', 'a tube'],
    ['prism_r10h30_s8.stl', 'a faceted prism'],
    ['box_open.stl', 'an open box - a POCKET, the case Thicken in exists for'],
    ['box-20mm.stl', 'a cube'],
    ['fixture_sphere_curved.stl', 'a sphere - no axis anywhere'],
    ['fixture_blob_organic.stl', 'an organic blob'],
    ['fixture_groove_concave.stl', 'a concave groove'],
    ['lid_strap.stl', 'a flat strap'],
    ['pin.stl', 'a pin with end chamfers'],
    ['hinge_pip.stl', 'a hinge pip'],
    ['box_hull_80x40x20-2.stl', 'a hull box']
  ];
  for (const [file, what] of cases) {
    const soup = fx(file);
    for (const mode of ['out', 'in']) {
      const two = _thickenOffsetSoup(soup, mode, 1.5);
      const three = _thickenOffsetSoup(soup, mode, 1.5, undefined);
      const four = _thickenOffsetSoup(soup, mode, 1.5, {});
      const same = (a, b) => {
        if (!a.soup || !b.soup) return (!a.soup && !b.soup) && a.reason === b.reason;
        if (a.soup.length !== b.soup.length) return false;
        for (let i = 0; i < a.soup.length; i++) if (a.soup[i] !== b.soup[i]) return false;
        return a.moved === b.moved && a.held === b.held && a.approx === b.approx;
      };
      check('Thicken ' + mode + ' 1.5 on ' + file + ' (' + what + '): 2-arg == 3-arg undefined == empty opts',
            same(two, three) && same(two, four),
            two.soup ? 'moved ' + two.moved + ', held ' + two.held : 'refused: ' + two.reason);
      check('  ...and the empty filter moved nothing out of the way',
            (four.filtered || 0) === 0);
    }
  }
}
{
  // The filter narrows and never widens: whatever Thicken would not have
  // moved, it still does not move, however permissive the mask.
  const soup = fx('box_open.stl');
  const nf = soup.length / 9;
  const all = new Uint8Array(nf).fill(1);
  const base = _thickenOffsetSoup(soup, 'in', 1);
  const masked = _thickenOffsetSoup(soup, 'in', 1, { mayMove: all });
  let same = base.soup.length === masked.soup.length;
  for (let i = 0; same && i < base.soup.length; i++) if (base.soup[i] !== masked.soup[i]) same = false;
  check('an all-ones mask is a no-op - the filter cannot widen the moving set',
        same && base.moved === masked.moved, 'moved ' + base.moved + ', held ' + base.held);
  const none = _thickenOffsetSoup(soup, 'in', 1, { mayMove: new Uint8Array(nf) });
  check('an all-zeros mask refuses by name rather than returning the input as a result',
        !none.soup && /survives the caller/.test(none.reason || ''), none.reason);
}
{
  // Fatten never reaches for the 'in' side, but the filter has to compose with
  // it correctly all the same, or the next wrapper inherits a trap.
  const soup = fx('box_open.stl');
  const nf = soup.length / 9;
  const half = new Uint8Array(nf);
  for (let i = 0; i < nf; i += 2) half[i] = 1;
  const r = _thickenOffsetSoup(soup, 'in', 0.5, { mayMove: half });
  const base = _thickenOffsetSoup(soup, 'in', 0.5);
  check('a half mask on Thicken in moves strictly fewer faces than no mask',
        r.soup && r.moved < base.moved && r.moved + r.held === base.moved + base.held,
        'moved ' + r.moved + ' of ' + base.moved + ', filtered ' + r.filtered);
}

/* ======================================================================
   E. The length gate itself
   ====================================================================== */
console.log('\n== E. the length gate refuses a length that moved ==');
{
  const soup = fx('cylinder_r10h30_s64.stl');
  const gate = NSO_fattenLengthGate(2);
  check('it passes a soup that did not move along the axis', gate(soup, soup) === null);
  const grown = _thickenOffsetSoup(soup, 'out', 1).soup;   // unrestricted: length moved
  const why = gate(soup, grown);
  check('it catches a whole-surface offset, which is exactly what it is for',
        typeof why === 'string' && /length moved/.test(why), why);
  const r = fattenRaw(soup, 'grow', 1);
  const a = NSO_extendLengthToReach(soup, 2, 0), b = NSO_extendLengthToReach(r.tris, 2, 0);
  check('on the real bake the residual is 0, not merely inside the allowance',
        b.current - a.current === 0,
        'extent ' + a.current + ' → ' + b.current + ', allowance 8 ULPs');
}

console.log('\n' + (fail ? 'FATTEN SELF-TEST: ' + fail + ' FAILED of ' + (pass + fail) + '\n  ' + FAILS.join('\n  ')
                          : 'FATTEN SELF-TEST: all ' + pass + ' checks passed'));
process.exit(fail ? 1 : 0);
