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

/* ---- paintSixOuter, the real exported function, on the real fixture ----
   The local copy of this maths that used to live here is gone on purpose: a
   copy is what let the n[0] bug sit unnoticed while a test agreed with it.
   tools/cth-test/paint-six-outer.test.mjs covers the raw/display split in
   detail; this file only asks the narrower question the drive depends on -
   do all six painted faces land on the hull of THIS fixture, so the wrap is
   not refused. */
const ROT = (r) => [r[0], r[2], -r[1]];                  // zUpToYUp: rotateX(-90)
const corners = [];
for (const x of [lo[0], hi[0]])
  for (const y of [lo[1], hi[1]])
    for (const z of [lo[2], hi[2]]) corners.push([x, y, z]);
const rot = corners.map(ROT);
const dCtr = [0, 1, 2].map((k) => (Math.min(...rot.map((p) => p[k])) + Math.max(...rot.map((p) => p[k]))) / 2);
const disp = rot.map((p) => p.map((v, k) => v - dCtr[k]));   // geometry.center()

const model = { id: 1, name: 'CTH_fixture.stl', rawAxis: 'zup',
                rawTris: new Float32Array(corners.flat()), faceMask: { exclude: [] } };
globalThis.window = {
  state: { models: [model], placed: [{ sourceId: 1, mesh: { geometry: { attributes: { position: {
    count: disp.length,
    getX: (i) => disp[i][0], getY: (i) => disp[i][1], getZ: (i) => disp[i][2],
  } } } } }] },
  nsoMaskRestore: (m, snap) => { m.faceMask = { exclude: snap }; },
  nsoMaskCount: (m) => m.faceMask.exclude.length,
};
const { paintSixOuter } = await import('../../cth/nest-paint-soften-drive.js');

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

console.log('\npaintSixOuter on the shipped fixture');
const n = paintSixOuter(model);
const snap = model.faceMask.exclude;
ok('paints six faces', n === 6 && snap.length === 6, 'n=' + n);
ok('no entry has d === 0  (the n[0] bug zeroed four)',
   snap.every((e) => e.d !== 0), snap.map((e) => e.d).join(','));
ok('brickSkipLists lands all six on the hull - the wrap is not refused',
   snap.every((e) => entryLands(e) === 'hull'), snap.map(entryLands).join(','));
ok('no entry is rejected as a plane the soup does not carry',
   !snap.some((e) => entryLands(e) === 'bad'));

// the shape of the old failure, kept as a regression note: an entry claiming
// plane 0.00 is exactly what brickSkipLists refuses on this piece.
ok('a d === 0 entry would still be refused (what the old code produced)',
   entryLands({ axisIdx: 2, keepMin: true, d: 0 }) === 'bad');

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
