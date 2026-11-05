/* Cut on an inside-out piece: refused until the person says to turn it.
   node tools/nso_cut_inside_out_test.js        exit 0 = every gate held

   THE DEAD END. A piece whose faces all point inward (negative volume -
   library/USB_bit.stl is one) is refused by Cut: cutFaceProblem finds the cut
   face would have to run the same way as the walls it closes. Correct, but
   the person had no way on from there.

   THE CHOICE (app-cut.js, "Cut on an inside-out piece"). The refusal now
   carries err.insideOut, and cutActiveModel asks cutInsideOutVerdict whether
   EVERY shell of the piece is inside-out. If so it offers one button; the
   click cuts cutRightSideOutCopy(piece) - every triangle reversed - and the
   piece itself is never touched. If only some shells are, the Cut is refused
   and cutPartlyInsideOutReason names them.

   This file drives those functions and splitBothSides itself in Node, on
   pieces built the way addModelFromZUpGeometry builds them, on both of
   Split's routes (raw triple, display mesh). The click, the buttons and Undo
   are driven in the real page by tools/nso_wire_cut_inside_out_test.js.

   Every fixture is made here: a box, a tube (Ø20 / Ø18 x 8, 128 segments)
   and a hollow box, each turned inside-out; and two pieces only partly
   inside-out - a box with a second, inside-out box beside it, and a box whose
   cavity is wound the wrong way. */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const THREE = require(path.join(ROOT, 'node_modules', 'three', 'build', 'three.cjs'));
const ctx = { Math, Map, Set, console, Array, Object, Number, String, JSON, isFinite, Float32Array,
  Float64Array, Int32Array, Uint32Array, Uint8Array, ArrayBuffer, Error, Infinity, NaN, THREE };
ctx.window = ctx;
vm.createContext(ctx);
vm.runInContext('var state = {}; var document = { readyState: "complete", getElementById: function () { return null; },' +
  ' addEventListener: function () {} };', ctx);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'app-cut.js'), 'utf8'), ctx, { filename: 'app-cut.js' });
const { splitBothSides, cutReverseWinding, cutShellsOf, cutInsideOutVerdict, cutPartlyInsideOutReason,
  cutRightSideOutCopy } = ctx;
const CUT_INSIDE_OUT_REASON = vm.runInContext('CUT_INSIDE_OUT_REASON', ctx);   // a const: not on ctx
const { topo } = require('./nso_cut_bore_measure');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) pass++; else fail++;
  console.log('  ' + (cond ? 'ok    ' : 'FAIL  ') + name + (detail ? '   ' + detail : ''));
}

/* ---------------- fixtures, in the file's own frame (Z up) ---------------- */

// An axis-aligned box, faces out.
function box(x0, y0, z0, x1, y1, z1) {
  const P = [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]];
  const F = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4],
             [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  const o = [];
  for (const f of F) for (const v of f) o.push(...P[v]);
  return o;
}
// The Ø20 / Ø18 x 8 tube along Z, faces out.
const SEG = 128, R_OUT = 10, R_IN = 9, H = 8;
function tube() {
  const o = [];
  // By segment index, so the last segment closes on the first's own vertices.
  const P = (r, i, w) => { const t = 2 * Math.PI * (i % SEG) / SEG; return [r * Math.cos(t), r * Math.sin(t), w]; };
  const q = (A, B, C, D) => o.push(...A, ...B, ...C, ...A, ...C, ...D);
  for (let i = 0; i < SEG; i++) {
    const a = i, b = i + 1;
    q(P(R_OUT, a, 0), P(R_OUT, b, 0), P(R_OUT, b, H), P(R_OUT, a, H));
    q(P(R_IN, b, 0), P(R_IN, a, 0), P(R_IN, a, H), P(R_IN, b, H));
    q(P(R_IN, a, H), P(R_OUT, a, H), P(R_OUT, b, H), P(R_IN, b, H));
    q(P(R_IN, b, 0), P(R_OUT, b, 0), P(R_OUT, a, 0), P(R_IN, a, 0));
  }
  return o;
}
const reversed = s => Array.from(cutReverseWinding(new Float32Array(s)));
// Off the origin on purpose, so nothing rests on a centred frame.
const BOX = box(5, 3, 1, 25, 15, 11);                                     // 20 x 12 x 10 = 2400 mm³
const HOLLOW = box(0, 0, 0, 30, 30, 30).concat(reversed(box(2, 2, 2, 28, 28, 28)));   // 30³ - 26³ = 9424
const FIXTURES = [
  { name: 'box', out: BOX, vol: 2400 },
  { name: 'tube', out: tube(), vol: SEG / 2 * Math.sin(2 * Math.PI / SEG) * (R_OUT * R_OUT - R_IN * R_IN) * H },
  { name: 'hollow box', out: HOLLOW, vol: 30 * 30 * 30 - 26 * 26 * 26 }
];
FIXTURES.forEach(f => { f.inv = reversed(f.out); });

/* A piece the way addModelFromZUpGeometry + addModel build it: rawTris kept
   verbatim, display = rotateX(-PI/2) then centred, centerOffset recorded. */
function makePiece(raw, withRaw) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(raw), 3));
  g.rotateX(-Math.PI / 2);
  g.computeBoundingBox();
  const bb = g.boundingBox;
  const off = { x: (bb.min.x + bb.max.x) / 2, y: (bb.min.y + bb.max.y) / 2, z: (bb.min.z + bb.max.z) / 2 };
  g.center();
  return withRaw ? { id: 1, name: 'p', geometry: g, rawTris: new Float32Array(raw), rawAxis: 'zup', centerOffset: off }
                 : { id: 1, name: 'p', geometry: g, rawTris: null, rawAxis: null, centerOffset: null };
}
const soupOf = geo => geo.attributes.position.array;
const bytesOf = a => Buffer.from(a.buffer, a.byteOffset, a.byteLength);
const sameBits = (a, b) => a.length === b.length && bytesOf(a).equals(bytesOf(b));
function closedOut(T) { return T.dupFaces === 0 && T.badEdge === 0 && T.badWinding === 0 && T.volume > 0; }
const tStr = T => 'bad edges ' + T.badEdge + ', bad winding ' + T.badWinding + ', dup ' + T.dupFaces +
  ', volume ' + T.volume.toFixed(3) + ' mm³';
function tryCut(piece, axis, lo, hi) {
  try { return { pair: splitBothSides(piece, axis, lo, hi) }; } catch (err) { return { err }; }
}

console.log('\n=== 0. the turn itself ===');
{
  const s = new Float32Array(tube());
  check('turning twice gives the soup back bit for bit', sameBits(cutReverseWinding(cutReverseWinding(s)), s));
  const T = topo(cutReverseWinding(s)), T0 = topo(s);
  check('turning negates the volume and keeps every edge paired', T.badEdge === 0 && T.badWinding === 0 &&
    Math.abs(T.volume + T0.volume) < 1e-9 * T0.volume, T.volume.toFixed(4) + ' vs ' + T0.volume.toFixed(4));
  check('the refusal reason is the one Cut gave before', /faces point inward \(it is inside-out\)/.test(CUT_INSIDE_OUT_REASON));
}

console.log('\n=== 1. pieces inside-out as a whole: refused, then offered, then cut ===');
for (const f of FIXTURES) {
  for (const withRaw of [true, false]) {
    const route = withRaw ? 'raw' : 'display';
    for (const axis of withRaw ? ['x', 'z', 'y'] : ['x', 'z']) {
      const tag = f.name + ' [' + route + ', cut ' + axis.toUpperCase() + ']';
      const piece = makePiece(f.inv, withRaw);
      const keepRaw = piece.rawTris && new Float32Array(piece.rawTris);
      const keepDisp = new Float32Array(soupOf(piece.geometry));
      const plane = 1.3;

      // Without the click: refused as now.
      const r0 = tryCut(piece, axis, plane - 0.5, plane + 0.5);
      check(tag + ': refused without the click, for the inside-out reason',
        !r0.pair && r0.err && r0.err.name === 'CutRefused' && r0.err.insideOut === true &&
        r0.err.message === CUT_INSIDE_OUT_REASON, r0.err ? r0.err.message : 'it was cut');

      const v = cutInsideOutVerdict(piece);
      check(tag + ': every shell is inside-out, so the button is offered', v.whole,
        v.shells.length + ' shell(s), inside-out: ' + v.wrong.map(i => i + 1).join(','));

      // The click: a turned copy; the piece itself untouched.
      const copy = cutRightSideOutCopy(piece);
      const Tc = topo(copy.rawTris || soupOf(copy.geometry));
      check(tag + ': turned, it is closed, 2-manifold, volume positive', closedOut(Tc), tStr(Tc));
      check(tag + ': its volume is the original\'s absolute volume',
        Math.abs(Tc.volume - Math.abs(topo(f.inv).volume)) < 1e-9 * f.vol && Math.abs(Tc.volume - f.vol) < 1e-4 * f.vol,
        Tc.volume.toFixed(4) + ' vs ' + f.vol.toFixed(4));
      if (withRaw) {
        const Td = topo(soupOf(copy.geometry));
        check(tag + ': its display mesh is turned too', closedOut(Td), tStr(Td));
      }
      check(tag + ': the piece itself is not touched (raw and display, bit for bit)',
        (!keepRaw || sameBits(piece.rawTris, keepRaw)) && sameBits(soupOf(piece.geometry), keepDisp));

      const r1 = tryCut(copy, axis, plane - 0.5, plane + 0.5);
      check(tag + ': with the click it is cut', !!r1.pair, r1.err && r1.err.message);
      if (!r1.pair) continue;
      check(tag + ': on the ' + route + ' route', r1.pair.engine === route, r1.pair.engine);
      const halves = [soupOf(r1.pair.left), soupOf(r1.pair.right)].map(topo);
      halves.forEach((T, i) => check(tag + ' half ' + 'AB'[i] + ': closed, 2-manifold, volume positive',
        closedOut(T), tStr(T)));
      // Same Cut on the piece built right-side-out to begin with: the same halves, bit for bit.
      const twin = tryCut(makePiece(f.out, withRaw), axis, plane - 0.5, plane + 0.5);
      check(tag + ': the halves are bit for bit the halves of the same piece built right-side-out',
        !!twin.pair && sameBits(soupOf(twin.pair.left), soupOf(r1.pair.left)) &&
        sameBits(soupOf(twin.pair.right), soupOf(r1.pair.right)), twin.err && twin.err.message);
      // No kerf: the two halves are the piece, split.
      const r2 = tryCut(copy, axis, plane, plane);
      const sum = r2.pair ? topo(soupOf(r2.pair.left)).volume + topo(soupOf(r2.pair.right)).volume : NaN;
      check(tag + ': cut on one plane, the halves\' volumes add up to the piece\'s',
        Math.abs(sum - Tc.volume) < 1e-5 * Tc.volume, sum.toFixed(4) + ' vs ' + Tc.volume.toFixed(4));
    }
  }
}

console.log('\n=== 2. pieces only partly inside-out: refused, naming the shells ===');
const MIXED = [
  { name: 'box with an inside-out box beside it', soup: BOX.concat(reversed(box(5, 20, 1, 25, 26, 11))),
    wrong: [1], want: /shell 2 of 2 \(12 triangles, 20\.0 x 10\.0 x 6\.0 mm\) is inside-out, while shell 1 is not/ },
  { name: 'box whose cavity is wound the wrong way', soup: box(0, 0, 0, 30, 30, 30).concat(box(2, 2, 2, 28, 28, 28)),
    wrong: [1], want: /shell 2 of 2 \(12 triangles, 26\.0 x 26\.0 x 26\.0 mm\) is inside-out, while shell 1 is not/ },
  { name: 'inside-out box with a right box beside it and a third inside-out',
    soup: reversed(BOX).concat(box(5, 20, 1, 25, 26, 11), reversed(box(5, -10, 1, 25, -4, 11))),
    wrong: [0, 2], want: /shell 1 of 3 \(12 triangles, 20\.0 x 10\.0 x 12\.0 mm\) and shell 3 of 3 \(12 triangles, 20\.0 x 10\.0 x 6\.0 mm\) are inside-out, while shell 2 is not, so turning the whole piece would turn shell 2 inside-out instead/ }
];
for (const f of MIXED) {
  for (const withRaw of [true, false]) {
    const tag = f.name + ' [' + (withRaw ? 'raw' : 'display') + ']';
    const piece = makePiece(f.soup, withRaw);
    const r = tryCut(piece, 'x', 0.8, 1.8);
    check(tag + ': Cut refuses it as inside-out', !r.pair && r.err && r.err.insideOut === true,
      r.err ? r.err.message : 'it was cut');
    const v = cutInsideOutVerdict(piece);
    check(tag + ': not offered (not every shell is inside-out)', !v.whole);
    check(tag + ': the inside-out shells are ' + f.wrong.map(i => i + 1).join(' and '),
      v.wrong.join() === f.wrong.join(), 'got ' + v.wrong.map(i => i + 1).join(','));
    const why = cutPartlyInsideOutReason(v);
    check(tag + ': the reason names them', f.want.test(why), why);
    check(tag + ': and says nothing was turned', /nothing was turned/.test(why));
  }
}

console.log('\n=== 3. pieces that are not inside-out are not judged so ===');
for (const [name, soup] of [['box', BOX], ['tube', tube()], ['hollow box, cavity wound inward as it should be', HOLLOW],
                            ['two boxes side by side', BOX.concat(box(5, 20, 1, 25, 26, 11))]]) {
  const v = cutInsideOutVerdict(makePiece(soup, true));
  check(name + ': no shell is inside-out', v.wrong.length === 0 && !v.whole,
    v.shells.map(s => 'depth ' + s.depth + ' vol ' + s.volume.toFixed(1)).join('; '));
  const r = tryCut(makePiece(soup, true), 'x', 0.8, 1.8);
  check(name + ': Cut cuts it as before', !!r.pair, r.err && r.err.message);
}
{
  const sh = cutShellsOf(new Float32Array(HOLLOW));
  check('hollow box: two shells, the cavity one deep and enclosing negative volume',
    sh.length === 2 && sh[0].depth === 0 && sh[1].depth === 1 && sh[0].volume > 0 && sh[1].volume < 0,
    sh.map(s => 'depth ' + s.depth + ' vol ' + s.volume.toFixed(1)).join('; '));
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
