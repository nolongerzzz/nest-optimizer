/* paintSixOuter, driven directly - no browser, no THREE.

   The driver's paint step is pure arithmetic over two boxes: the piece's raw
   soup (what the wrap reads) and its display geometry (what the yellow reads).
   Both can be synthesised, so the real exported function runs here against a
   piece the shipped fixture cannot expose: off-origin on every axis, and with
   three different extents, so a display/raw mix-up and a dropped sign flip
   both have somewhere to show.

   Run: node tools/cth-test/paint-six-outer.test.mjs */

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  -> ' + extra : '')); }
}

/* ---- the display transform Nest actually applies on import ----
   app-core.js: zUpToYUp() is rotateX(-PI/2), then geometry.center().
   rotateX(-90): x' = x, y' = z, z' = -y. So display X = raw X,
   display Y = raw Z, display Z = raw -Y. */
const ROT = (r) => [r[0], r[2], -r[1]];

function makePiece(rawLo, rawHi) {
  // eight corners is enough: paintSixOuter only ever reads the bbox.
  const corners = [];
  for (const x of [rawLo[0], rawHi[0]])
    for (const y of [rawLo[1], rawHi[1]])
      for (const z of [rawLo[2], rawHi[2]]) corners.push([x, y, z]);

  const rot = corners.map(ROT);
  const lo = [0, 1, 2].map((k) => Math.min(...rot.map((p) => p[k])));
  const hi = [0, 1, 2].map((k) => Math.max(...rot.map((p) => p[k])));
  const centerOffset = [0, 1, 2].map((k) => (lo[k] + hi[k]) / 2);
  const disp = rot.map((p) => p.map((v, k) => v - centerOffset[k]));   // .center()

  const position = {
    count: disp.length,
    getX: (i) => disp[i][0], getY: (i) => disp[i][1], getZ: (i) => disp[i][2],
  };
  // the raw soup the wrap reads - untransformed, untranslated, as imported
  const rawTris = new Float32Array(corners.flat());
  const model = { id: 7, name: 'CTH_fixture.stl', rawAxis: 'zup', rawTris,
                  centerOffset: { x: centerOffset[0], y: centerOffset[1], z: centerOffset[2] },
                  faceMask: { exclude: [] } };
  return {
    model,
    centerOffset,
    dispLo: [0, 1, 2].map((k) => lo[k] - centerOffset[k]),
    dispHi: [0, 1, 2].map((k) => hi[k] - centerOffset[k]),
    placed: { sourceId: 7, mesh: { geometry: { attributes: { position } } } },
  };
}

/* ---- the window surface paintSixOuter reaches for ---- */
let snapshot = null;
globalThis.window = {
  state: null,
  nsoMaskRestore: (m, snap) => { snapshot = snap; m.faceMask = { exclude: snap }; },
  nsoMaskCount: (m) => (m && m.faceMask ? m.faceMask.exclude.length : 0),
};

const { paintSixOuter } = await import('../../cth/nest-paint-soften-drive.js');

function paint(piece) {
  window.state = { models: [piece.model], placed: [piece.placed] };
  snapshot = null;
  const n = paintSixOuter(piece.model);
  return { n, snap: snapshot };
}

/* ---- what a correct entry looks like ----
   app-mask.js:466-476 writes n[rawAxisIdx] = keepMin ? -1 : 1 and
   d = keepMin ? -at : at, with `at` the RAW plane. The overlay reads
   dispPlane, in display space. One pick, both spaces, no drift. */
function check(label, piece, rawLo, rawHi) {
  console.log('\n' + label);
  console.log('  raw   [' + rawLo + '] .. [' + rawHi + ']');
  console.log('  centerOffset ' + piece.centerOffset.map((v) => v.toFixed(1)).join(', '));

  const { n, snap } = paint(piece);
  ok('six faces painted', n === 6 && snap && snap.length === 6, 'n=' + n);
  if (!snap || snap.length !== 6) return;

  // every raw axis, both sides, exactly once
  const seen = new Set(snap.map((e) => e.axisIdx + (e.keepMin ? '-' : '+')));
  ok('covers all six raw half-spaces once',
     seen.size === 6 && [0, 1, 2].every((a) => seen.has(a + '-') && seen.has(a + '+')),
     [...seen].join(','));

  for (const e of snap) {
    const tag = 'raw ' + 'XYZ'[e.axisIdx] + (e.keepMin ? '-' : '+');
    const at = e.keepMin ? -e.d : e.d;
    const want = e.keepMin ? rawLo[e.axisIdx] : rawHi[e.axisIdx];
    ok('  ' + tag + ' plane = ' + want, Math.abs(at - want) < 1e-6, 'got ' + at.toFixed(3));
    ok('  ' + tag + ' normal points outward',
       e.n[e.axisIdx] === (e.keepMin ? -1 : 1) &&
       e.n.filter((v) => v !== 0).length === 1,
       JSON.stringify(e.n));

    // the display half this raw face is: display Z is raw -Y, so the raw Y
    // MIN face is the display Z MAX face. A dropped sign flip lands here.
    const rawSideIsMin = e.keepMin;
    const flipped = e.dispAxis === 2;                       // only display Z flips
    const dispSideIsMin = flipped ? !rawSideIsMin : rawSideIsMin;
    ok('  ' + tag + ' -> display ' + 'XYZ'[e.dispAxis] + (dispSideIsMin ? '-' : '+'),
       e.dispSign === (dispSideIsMin ? -1 : 1),
       'dispSign=' + e.dispSign);
    const wantPlane = dispSideIsMin ? piece.dispLo[e.dispAxis] : piece.dispHi[e.dispAxis];
    ok('  ' + tag + ' dispPlane = ' + wantPlane.toFixed(2),
       Math.abs(e.dispPlane - wantPlane) < 1e-6, 'got ' + e.dispPlane.toFixed(3));
  }
}

// the shipped fixture: centred on the origin, Y span symmetric. Both defects
// are invisible here, which is why the drive passed its own test on it.
const A_LO = [-40, -20, -10], A_HI = [40, 20, 10];
check('centred, symmetric (library/CTH_fixture.stl)', makePiece(A_LO, A_HI), A_LO, A_HI);

// off-origin on every axis, three different extents, no symmetry anywhere.
const B_LO = [10, -3, 5], B_HI = [70, 27, 17];
check('off-origin, asymmetric', makePiece(B_LO, B_HI), B_LO, B_HI);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
