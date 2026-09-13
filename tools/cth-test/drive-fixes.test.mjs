/* Node checks for the two ?cth=drive fixes. No browser, no THREE: the paint
   maths and the grade rule are both pure, so they can be exercised directly
   against the real fixture and the real status strings Nest emits.
   Run: node tools/cth-test/drive-fixes.test.mjs */
import { readFileSync } from 'node:fs';
import { gradeNestSoftenStatus } from '../../cth/nest-status-grade.js';

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  -> ' + extra : '')); }
}

/* ---- fixture: the same STL the driver fetches ---- */
const buf = readFileSync(new URL('../../library/CTH_fixture.stl', import.meta.url));
const nTri = buf.readUInt32LE(80);
const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
for (let t = 0; t < nTri; t++) {
  const o = 84 + t * 50 + 12;
  for (let v = 0; v < 3; v++) {
    for (let k = 0; k < 3; k++) {
      const c = buf.readFloatLE(o + v * 12 + k * 4);
      if (c < lo[k]) lo[k] = c;
      if (c > hi[k]) hi[k] = c;
    }
  }
}

/* Raw axis-aligned planes actually on the soup, by (axis, outward sign).
   This is what rawHasPlane / brickSkipLists consult. */
const planes = new Map();
for (let t = 0; t < nTri; t++) {
  const o = 84 + t * 50 + 12;
  const P = (v) => [0, 1, 2].map((k) => buf.readFloatLE(o + v * 12 + k * 4));
  const [a, b, c] = [P(0), P(1), P(2)];
  const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  let n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
  const L = Math.hypot(...n);
  if (!(L > 1e-12)) continue;
  n = n.map((x) => x / L);
  for (let k = 0; k < 3; k++) {
    if (Math.abs(n[k]) > 0.999) {
      const key = k + ':' + (n[k] > 0 ? 1 : -1);
      if (!planes.has(key)) planes.set(key, new Set());
      planes.get(key).add(Number(a[k].toFixed(4)));
    }
  }
}
const FACE_PICK_TOL = 0.35;                      // app-finish.js:5239
const rawHasPlane = (axis, keepMin, at) => {
  const s = planes.get(axis + ':' + (keepMin ? -1 : 1));
  return !!s && [...s].some((p) => Math.abs(p - at) < FACE_PICK_TOL);
};

/* ---- paintSixOuter, both the old line and the fixed one ---- */
// display X = raw X (0), display Y = raw Z (2), display Z = raw -Y (1)
function buildSnap(dlo, dhi, dFormula) {
  const rawOf = [0, 2, 1];
  const snap = [];
  for (let a = 0; a < 3; a++) {
    const axis = rawOf[a];
    const mk = (keepMin) => ({
      n: [0, 1, 2].map((k) => (k === axis ? (keepMin ? -1 : 1) : 0)),
      d: 0, axisIdx: axis, keepMin, inner: false,
      dispAxis: a, dispSign: keepMin ? -1 : 1, dispPlane: keepMin ? dlo[a] : dhi[a],
    });
    snap.push(mk(true), mk(false));
  }
  for (const e of snap) e.d = dFormula(e, dlo, dhi);
  return snap;
}
const OLD = (e, dlo, dhi) => e.n[0] * (e.keepMin ? dlo[e.dispAxis] : dhi[e.dispAxis]);
const NEW = (e, dlo, dhi) => e.n[e.axisIdx] * (e.keepMin ? dlo[e.dispAxis] : dhi[e.dispAxis]);

// display bbox after zUpToYUp + geometry.center(): X=rawX, Y=rawZ, Z=-rawY,
// and this fixture is already centred on the origin.
const dlo = [lo[0], lo[2], -hi[1]], dhi = [hi[0], hi[2], -lo[1]];

/* brickSkipLists' verdict for one painted entry (app-finish.js:3235). */
const brick = { lo: [...lo], hi: [...hi] };
function entryLands(e) {
  const at = e.keepMin ? -e.d : e.d;
  const span = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
  const tol = Math.max(0.05, 0.005 * span);
  const dHull = Math.abs(at - (e.keepMin ? brick.lo[e.axisIdx] : brick.hi[e.axisIdx]));
  if (dHull < tol) return 'hull';
  return rawHasPlane(e.axisIdx, e.keepMin, at) ? 'pocket' : 'bad';
}

console.log('\nfixture library/CTH_fixture.stl  tris=' + nTri +
            '  raw bbox [' + lo.map((v) => v.toFixed(1)) + '] .. [' + hi.map((v) => v.toFixed(1)) + ']');

console.log('\npaintSixOuter - plane offsets');
const before = buildSnap(dlo, dhi, OLD);
const after = buildSnap(dlo, dhi, NEW);
ok('old line zeroed d on 4 of 6 faces (the bug)',
   before.filter((e) => e.d === 0).length === 4,
   'zeros=' + before.filter((e) => e.d === 0).length);
ok('old line: brickSkipLists rejects at least one face',
   before.some((e) => entryLands(e) === 'bad'),
   before.map(entryLands).join(','));
ok('fixed line: no entry has d === 0',
   after.every((e) => e.d !== 0),
   after.map((e) => e.d).join(','));
ok('fixed line: all six land on the hull',
   after.every((e) => entryLands(e) === 'hull'),
   after.map(entryLands).join(','));
for (const e of after) {
  const at = e.keepMin ? -e.d : e.d;
  const want = e.keepMin ? lo[e.axisIdx] : hi[e.axisIdx];
  ok('  raw axis ' + e.axisIdx + (e.keepMin ? '-' : '+') + ' plane ' + at.toFixed(2),
     Math.abs(at - want) < 1e-6, 'wanted ' + want);
}

/* ---- the grade rule, on the real Nest status lines ---- */
console.log('\ngrade rule - real Nest #status strings');
const cases = [
  ['Wrapping 5 face(s), 6 painted out…', 'pending'],
  ['Wrapping 1 pocket, 6 face(s) painted out…', 'pending'],
  ['Round wrap R 0.50 on a pocket piece - 5 of 11 faces baked (hull 0/6, pocket 5/5), 6 painted out and left square (912 tris, one bake from source)', 'pass'],
  ['Round wrap R 0.50 inside - 1 pocket wrapped, 6 face(s) painted out and left square, hull untouched (912 tris, one bake from source)', 'pass'],
  ['Soften ok', 'pass'],
  ['Soften (round): click a face', 'fail'],
  ['Wrap stopped - the Z- face at 0.00 is gone from this piece; the soup has no face on that plane any more. Clear paint and paint it again. Piece unchanged', 'fail'],
  ['Wrap failed - the cut did not close (open 0→4, non-manifold 0→0). Piece unchanged', 'fail'],
  ['Select a piece first', 'fail'],
  ['Still wrapping the last click', 'fail'],
];
for (const [text, want] of cases) {
  const g = gradeNestSoftenStatus(text);
  ok('[' + want + '] ' + text.slice(0, 62), g.result === want, 'got ' + g.result + '/' + g.reason);
}

// the drift the old private grade had already introduced
const inPlace = cases[3][0];
ok('old /baked/i && /painted/i mis-scored the in-place success line',
   !(/baked/i.test(inPlace) && /painted/i.test(inPlace)));
ok('shared rule scores that same line a pass',
   gradeNestSoftenStatus(inPlace).result === 'pass');

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
