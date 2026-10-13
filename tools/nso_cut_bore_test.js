/* Cut keeps a tube's bore open: on every axis, on every piece, on both of
   Split's routes.          node tools/nso_cut_bore_test.js   exit 0 = all held

   THE DEFECT. Cutting a tube (Ø20 outer, Ø18 bore, 8 mm tall) could give
   halves whose bore was filled: the cut face carried the annulus AND a disc
   over the bore, two sets of faces on one plane (dark interleaved patterns in
   a slicer's 3D view; the slice itself came out right only because even-odd
   filling cancels the doubled faces). The raw engine (rawCut ->
   rawFlatCapLoops) caps a tube as one annulus. The faces came from the other
   engine Split used to fall back to without a word: clipGeometrySide ->
   capFromEdges, which ear-clips each loop on its own and so lids the bore.
   mapPlaneToRaw had no case for a display-Y cut, so EVERY Y cut (a piece
   rolled onto its side) took that path, as did every piece with no raw data.

   THE FIX (app-cut.js). splitBothSides runs rawCut for every Cut: in the raw
   frame when the piece has a raw triple (mapPlaneToRaw now maps display Y to
   raw Z), else on the display mesh as a triangle soup. Nothing falls back; a
   cut face rawCut cannot close exactly is a CutRefused error, which the Cut
   button reports in the status line (tools/nso_wire_cut_bore_test.js).

   This file drives splitBothSides itself - the function cutActiveModel calls -
   in Node, on pieces built the way addModelFromZUpGeometry builds them. */

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
for (const f of ['app-cut.js', 'app-extend.js']) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
}
const { splitBothSides, mapPlaneToRaw, rawCut, NSO_extendRaw } = ctx;
const { pk, topo, capOf } = require('./nso_cut_bore_measure');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) pass++; else fail++;
  console.log('  ' + (cond ? 'ok    ' : 'FAIL  ') + name + (detail ? '   ' + detail : ''));
}

/* ---------------- pieces, in the file's own frame (Z up) ---------------- */

const SEG = 128;
const R_OUT = 10, R_IN = 9, H = 8;                                  // the Ø20 / Ø18 x 8 tube
const ANNULUS_TRUE = Math.PI * (R_OUT * R_OUT - R_IN * R_IN);       // 59.69
const DISC_TRUE = Math.PI * R_OUT * R_OUT;                          // 314.16

// A point given (u, v) across raw axis k and w along it.
function place(k, u, v, w) {
  return k === 2 ? [u, v, w] : k === 0 ? [w, u, v] : [v, w, u];
}
// Which of u / v / w raw axis j is, for a prism along raw axis k.
function roleOf(k, j) {
  if (j === k) return 'w';
  return j === (k + 1) % 3 ? 'u' : 'v';
}
function circle(r, cu, cv) {
  const o = [];
  for (let i = 0; i < SEG; i++) { const t = 2 * Math.PI * i / SEG; o.push([cu + r * Math.cos(t), cv + r * Math.sin(t)]); }
  return o;
}
// The square [-S, S]^2 seen from (cu, cv): one boundary point per ray of the
// circle's angles, so it pairs up with a circle point by point.
function squareSeenFrom(S, cu, cv) {
  return circle(1, 0, 0).map(([dx, dy]) => {
    const t = Math.min(dx > 0 ? (S - cu) / dx : dx < 0 ? (-S - cu) / dx : Infinity,
                       dy > 0 ? (S - cv) / dy : dy < 0 ? (-S - cv) / dy : Infinity);
    return [cu + t * dx, cv + t * dy];
  });
}
function area2(poly) {
  let a = 0;
  for (let i = 0; i < poly.length; i++) { const p = poly[i], q = poly[(i + 1) % poly.length]; a += p[0] * q[1] - q[0] * p[1]; }
  return a / 2;
}
// A prism along raw axis k, w from w0 to w1: an outline (CCW) and optionally
// a hole with as many points, joined point by point on the end faces. With
// no hole the end faces are fanned from `centre`.
function prism(k, outer, hole, w0, w1, centre) {
  const o = [];
  const P = (p, w) => place(k, p[0], p[1], w);
  const quad = (A, B, C, D) => o.push(...A, ...B, ...C, ...A, ...C, ...D);
  const n = outer.length;
  for (let i = 0; i < n; i++) {
    const a = outer[i], b = outer[(i + 1) % n];
    quad(P(a, w0), P(b, w0), P(b, w1), P(a, w1));
    if (hole) {
      const c = hole[i], d = hole[(i + 1) % n];
      quad(P(d, w0), P(c, w0), P(c, w1), P(d, w1));
      quad(P(c, w1), P(a, w1), P(b, w1), P(d, w1));
      quad(P(d, w0), P(b, w0), P(a, w0), P(c, w0));
    } else {
      o.push(...P(centre, w1), ...P(a, w1), ...P(b, w1));
      o.push(...P(centre, w0), ...P(b, w0), ...P(a, w0));
    }
  }
  return { soup: new Float32Array(o), k, outer, hole, w0, w1 };
}
// The section a plane at raw coordinate c on raw axis j cuts from a prism:
// across it, the outline less the hole; along it, the chord through the
// outline less the chord through the hole, times the prism's length.
function sectionArea(pr, j, c) {
  const role = roleOf(pr.k, j);
  if (role === 'w') return Math.abs(area2(pr.outer)) - (pr.hole ? Math.abs(area2(pr.hole)) : 0);
  const ix = role === 'u' ? 0 : 1;
  function chord(poly) {
    const hits = [];
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i], q = poly[(i + 1) % poly.length];
      if ((p[ix] - c) * (q[ix] - c) < 0 || p[ix] === c) {
        const t = p[ix] === q[ix] ? 0 : (c - p[ix]) / (q[ix] - p[ix]);
        hits.push(p[1 - ix] + t * (q[1 - ix] - p[1 - ix]));
      }
    }
    return hits.length ? Math.max(...hits) - Math.min(...hits) : 0;
  }
  return (chord(pr.outer) - (pr.hole ? chord(pr.hole) : 0)) * (pr.w1 - pr.w0);
}
// Axis-aligned box [lo, hi] as 12 outward triangles.
function box(lo, hi) {
  const [x0, y0, z0] = lo, [x1, y1, z1] = hi, o = [];
  const quad = (A, B, C, D) => o.push(...A, ...B, ...C, ...A, ...C, ...D);
  quad([x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [x1, y0, z0]);
  quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]);
  quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]);
  quad([x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0]);
  quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]);
  quad([x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]);
  return new Float32Array(o);
}
function concat(parts) {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0; parts.forEach(p => { out.set(p, o); o += p.length; });
  return out;
}

// fixtures/box_cavity_30.stl: a 30 mm cube with 2 mm walls round a sealed
// 26 mm cavity. Two shells: the outside wound outward, the cavity's walls
// wound into the cavity (outward from the material). Two triangles a face.
const BOX_OUT = 15, BOX_IN = 13;
function boxCavity() {
  const outer = box([-BOX_OUT, -BOX_OUT, -BOX_OUT], [BOX_OUT, BOX_OUT, BOX_OUT]);
  const inner = box([-BOX_IN, -BOX_IN, -BOX_IN], [BOX_IN, BOX_IN, BOX_IN]);
  for (let t = 0; t < inner.length; t += 9) for (let c = 0; c < 3; c++) {
    const x = inner[t + 3 + c]; inner[t + 3 + c] = inner[t + 6 + c]; inner[t + 6 + c] = x;
  }
  return concat([outer, inner]);
}
const BOX_FIXTURE = path.join(ROOT, 'fixtures', 'box_cavity_30.stl');
function stlBytes(soup) {
  const n = soup.length / 9, b = Buffer.alloc(84 + n * 50);
  b.write('box_cavity_30: 30 mm cube, 2 mm walls, sealed 26 mm cavity', 0, 'ascii');
  b.writeUInt32LE(n, 80);
  for (let t = 0; t < n; t++) for (let k = 0; k < 9; k++) b.writeFloatLE(soup[t * 9 + k], 84 + t * 50 + 12 + k * 4);
  return b;
}
if (process.argv.includes('--write-fixture')) {
  fs.writeFileSync(BOX_FIXTURE, stlBytes(boxCavity()));
  console.log('wrote ' + BOX_FIXTURE);
  process.exit(0);
}
function readSTL(file) {
  const b = fs.readFileSync(file), n = b.readUInt32LE(80), o = new Float32Array(n * 9);
  for (let t = 0; t < n; t++) for (let k = 0; k < 9; k++) o[t * 9 + k] = b.readFloatLE(84 + t * 50 + 12 + k * 4);
  return o;
}

const ringPrism = k => prism(k, circle(R_OUT, 0, 0), circle(R_IN, 0, 0), 0, H);
const cylinderPrism = k => prism(k, circle(R_OUT, 0, 0), null, 0, H, [0, 0]);
// 30 mm block with a Ø6 bore whose centre sits at (8, 8) across it.
const boredBlockPrism = k => prism(k, squareSeenFrom(15, 8, 8), circle(3, 8, 8), -15, 15);

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
  return withRaw ? { geometry: g, rawTris: raw, rawAxis: 'zup', centerOffset: off }
                 : { geometry: g, rawTris: null, rawAxis: null, centerOffset: null };
}

/* ---------------- measurements on a cut half ---------------- */

const AX = { x: 0, y: 1, z: 2 };
function soupOf(geo) { return geo.attributes.position.array; }
// Every check the brief asks of a cut half.
function judge(label, geo, ai, plane, want) {
  const s = soupOf(geo);
  const T = topo(s);
  const c = capOf(s, ai, plane, want.probe);
  check(label + ': cut face area ' + c.area.toFixed(2) + ' mm²',
    Math.abs(c.area - want.area) < 1e-3 * want.area, 'want ' + want.area.toFixed(2) + (want.note ? ' (' + want.note + ')' : ''));
  check(label + ': cut face is ' + want.comps + ' piece(s), ' + want.loops + ' outline loop(s), cap chi ' + want.capChi,
    c.comps === want.comps && c.loops === want.loops && c.chi === want.capChi,
    'got ' + c.comps + ' piece(s), ' + c.loops + ' loop(s), chi ' + c.chi);
  if (want.probe) check(label + ': the hole\'s centre (bore or cavity) is NOT covered by the cut face', !c.coversProbe);
  check(label + ': no duplicate or coincident faces', T.dupFaces === 0, T.dupFaces + ' duplicate(s)');
  check(label + ': every edge shared by exactly two faces, winding agrees',
    T.badEdge === 0 && T.badWinding === 0, 'bad edges ' + T.badEdge + ', bad winding ' + T.badWinding);
  check(label + ': Euler characteristic ' + T.chi + ' (want ' + want.chi + ')', T.chi === want.chi,
    'V ' + T.V + ' E ' + T.E + ' F ' + T.F);
  check(label + ': encloses positive volume (faces point out)', T.volume > 0, T.volume.toFixed(3) + ' mm³');
  return { T, c };
}

// Display axis that raw axis j becomes, and a display plane's raw coordinate
// on a piece whose centerOffset is (0, 0, 0) across the cut (rotateX(-90):
// display (x, y, z) = raw (x, z, -y)).
const DISP_OF_RAW = ['x', 'z', 'y'];
const RAW_OF_DISP = { x: 0, y: 2, z: 1 };
const rawCoord = (axis, p, off) => axis === 'x' ? p + off.x : axis === 'y' ? p + off.y : -p - off.z;

// Cut the way cutActiveModel does: a 1 mm kerf band centred on `plane`. Each
// side is judged against the section the prism really has at its plane.
function cutBoth(label, pr, piece, axis, plane, want) {
  let pair = null, err = null;
  try { pair = splitBothSides(piece, axis, plane - 0.5, plane + 0.5); } catch (e) { err = e; }
  check(label + ': Split cuts it', !!pair, err && (err.name + ': ' + err.message));
  if (!pair) return null;
  const ai = AX[axis];
  const off = piece.centerOffset || piece.offForTest;
  [['left', plane - 0.5], ['right', plane + 0.5]].forEach(([side, pl]) => {
    const w = typeof want === 'function' ? want(side, pair) : want;
    judge(label + ' [' + side + ']', pair[side], ai, pl,
      w.area != null ? w : Object.assign({ area: sectionArea(pr, RAW_OF_DISP[axis], rawCoord(axis, pl, off)) }, w));
  });
  return pair;
}

// A piece built the way the app builds one, with or without its raw data.
// The display route has no centerOffset to read, so the test keeps it aside.
function pieceOf(soup, withRaw) {
  const p = makePiece(soup, true);
  if (withRaw) return p;
  return { geometry: p.geometry, rawTris: null, rawAxis: null, centerOffset: null, offForTest: p.centerOffset };
}

const ACROSS = { comps: 1, loops: 2, capChi: 0, chi: 0, probe: [0, 0] };   // one annulus; the half is a ring
const ALONG = { comps: 2, loops: 2, capChi: 2, chi: 2 };                   // two strips; the half is a C
const SOLID = { comps: 1, loops: 1, capChi: 1, chi: 2 };                   // one disc or face

try {
  console.log('\n=== 0. the defect, measured: the old engine lids the bore ===');
  {
    // capFromEdges on the two loops of the ring's section, as clipGeometrySide
    // handed them over: one ear clip per loop, no nesting.
    const edges = [];
    for (const r of [R_OUT, R_IN]) {
      const c = circle(r, 0, 0);
      for (let i = 0; i < SEG; i++) { const a = c[i], b = c[(i + 1) % SEG]; edges.push([[a[0], 0, a[1]], [b[0], 0, b[1]]]); }
    }
    const old = ctx.capFromEdges(edges, 'y', 0, true);
    let a = 0;
    for (let t = 0; t < old.length; t += 9) a += Math.abs((old[t+3]-old[t]) * (old[t+8]-old[t+2]) - (old[t+5]-old[t+2]) * (old[t+6]-old[t])) / 2;
    check('per-loop ear clip covers ' + a.toFixed(2) + ' mm²: the disc (' + DISC_TRUE.toFixed(2) + ') AND the bore again; the annulus is ' +
      ANNULUS_TRUE.toFixed(2), a > DISC_TRUE);
    check('clipGeometrySide and splitCutSide are gone (nothing can fall back to it)',
      typeof ctx.clipGeometrySide === 'undefined' && typeof ctx.splitCutSide === 'undefined');
  }

  console.log('\n=== 1. display Y maps to raw Z: sign, offset and keepMin, proved against the display mesh ===');
  {
    // An asymmetric piece, off centre on every axis, so a wrong sign, offset
    // or side would cut a different piece. For each display axis, the raw
    // route's result turned into the display frame must be the piece rawCut
    // makes from the display mesh itself with the same keepMin.
    const raw = concat([box([2, -7, 1], [17, 5, 9]), box([2, -7, 9], [6, 0, 21]),
                        prism(2, circle(6, 25, 3), circle(4, 25, 3), 0, 12).soup]);
    const piece = makePiece(raw, true);
    const disp = soupOf(piece.geometry);
    const bb = new THREE.Box3().setFromBufferAttribute(piece.geometry.attributes.position);
    const boxOf = s => new THREE.Box3().setFromBufferAttribute(new THREE.BufferAttribute(new Float32Array(s), 3));
    for (const axis of ['x', 'y', 'z']) {
      const ai = AX[axis];
      const plane = bb.min.getComponent(ai) + 0.37 * (bb.max.getComponent(ai) - bb.min.getComponent(ai));
      for (const keepMin of [true, false]) {
        const m = mapPlaneToRaw(piece, axis, plane, keepMin);
        check('mapPlaneToRaw maps display ' + axis.toUpperCase() + ', keepMin ' + keepMin +
          (m ? ' -> raw ' + 'XYZ'[m.axisIdx] + ' @ ' + m.plane.toFixed(3) + ', keepMin ' + m.keepMin : ''), !!m);
        if (!m) continue;
        const viaRawSoup = soupOf(ctx.rawResultToDisplayGeometry(rawCut(raw, m.axisIdx, m.plane, m.keepMin), piece.centerOffset));
        const viaDispSoup = rawCut(disp, ai, plane, keepMin);
        const viaRaw = topo(viaRawSoup), viaDisp = topo(viaDispSoup), other = topo(rawCut(disp, ai, plane, !keepMin));
        const b1 = boxOf(viaRawSoup), b2 = boxOf(viaDispSoup);
        const boxErr = Math.max(b1.min.distanceTo(b2.min), b1.max.distanceTo(b2.max));
        check('  raw route = display-mesh cut: volume ' + viaRaw.volume.toFixed(3) + ' vs ' + viaDisp.volume.toFixed(3) +
          ', bounds within ' + boxErr.toExponential(1) + ' mm, ' + viaRaw.F + ' vs ' + viaDisp.F + ' faces',
          Math.abs(viaRaw.volume - viaDisp.volume) < 1e-3 && boxErr < 1e-4 && viaRaw.F === viaDisp.F);
        check('  ... and not the other side of the plane (' + other.volume.toFixed(3) + ')', Math.abs(viaRaw.volume - other.volume) > 1);
      }
    }
  }

  const extended = k => {
    const r = NSO_extendRaw(ringPrism(k).soup, { length: 20 });
    if (!r.ok) throw new Error('Extend refused the tube: ' + r.reason);
    return r;
  };
  const TUBES = [
    ['ring', k => ({ pr: ringPrism(k), soup: ringPrism(k).soup })],
    // Extend lengthens the tube along its bore; the section is unchanged, so
    // the ring prism still describes every cross-section of it.
    ['ring after Extend to 20 mm', k => { const r = extended(k); const pr = ringPrism(k); pr.w0 = 0; pr.w1 = 20; return { pr, soup: r.tris }; }]
  ];

  for (const [name, make] of TUBES) {
    if (name !== 'ring') {
      const r = extended(2);
      check('Extend ran on the tube: ' + r.axis.toUpperCase() + ' ' + r.lengthBefore.toFixed(2) + ' -> ' + r.lengthAfter.toFixed(2) + ' mm',
        r.ok && Math.abs(r.lengthAfter - 20) < 1e-3);
    }
    for (const withRaw of [true, false]) {
      console.log('\n=== 2. ' + name + ', ' + (withRaw ? 'raw route (piece has rawTris)' : 'display route (no raw data)') +
                  ': across the bore, on X, Y and Z ===');
      for (let k = 0; k < 3; k++) {
        const { pr, soup } = make(k);
        const axis = DISP_OF_RAW[k];
        const pair = cutBoth(name + ', bore along ' + axis.toUpperCase() + ', cut ' + axis.toUpperCase() + ' @ +1.3',
          pr, pieceOf(soup, withRaw), axis, 1.3, ACROSS);
        if (pair) check('  engine: ' + pair.engine, pair.engine === (withRaw ? 'raw' : 'display'));
      }
      console.log('  -- along the bore, 0.2 mm off its centre: two strips, nothing over the bore');
      for (let k = 0; k < 3; k++) {
        const { pr, soup } = make(k);
        const bore = DISP_OF_RAW[k];
        for (const axis of ['x', 'y', 'z'].filter(a => a !== bore)) {
          cutBoth(name + ', bore along ' + bore.toUpperCase() + ', cut ' + axis.toUpperCase() + ' @ +0.2',
            pr, pieceOf(soup, withRaw), axis, 0.2, ALONG);
        }
      }
    }
  }

  console.log('\n=== 3. solid pieces still cap as one disc or face ===');
  for (const withRaw of [true, false]) {
    for (let k = 0; k < 3; k++) {
      const cyl = cylinderPrism(k);
      for (const axis of ['x', 'y', 'z']) {
        const pair = cutBoth('cylinder along ' + DISP_OF_RAW[k].toUpperCase() + ', cut ' + axis.toUpperCase() + ' @ +1.3 ' +
          (withRaw ? '(raw)' : '(display)'), cyl, pieceOf(cyl.soup, withRaw), axis, 1.3, SOLID);
        if (pair && withRaw && axis !== 'y') {
          // X and Z took the raw route before this change too: same rawCut,
          // same mapping, so the pieces must be byte-for-byte what they were.
          const p = pieceOf(cyl.soup, true);
          const m = mapPlaneToRaw(p, axis, 0.8, true);
          const before = rawCut(cyl.soup, m.axisIdx, m.plane, m.keepMin);
          check('  raw ' + axis.toUpperCase() + ' piece byte-identical to the pre-change raw route',
            before.length === pair.rawA.length && before.every((v, i) => v === pair.rawA[i]));
        }
      }
    }
    // A cube is a prism of a square: four corners, no hole.
    const sq = [[-10, -10], [10, -10], [10, 10], [-10, 10]];
    const cube = { soup: box([-10, -10, -10], [10, 10, 10]), k: 2, outer: sq, hole: null, w0: -10, w1: 10 };
    for (const axis of ['x', 'y', 'z']) {
      cutBoth('cube 20 mm, cut ' + axis.toUpperCase() + ' @ +1.3 ' + (withRaw ? '(raw)' : '(display)'),
        cube, pieceOf(cube.soup, withRaw), axis, 1.3, SOLID);
    }
  }

  console.log('\n=== 4. a bore the plane does not reach is left exactly as it was ===');
  for (const withRaw of [true, false]) {
    for (let k = 0; k < 3; k++) {
      const pr = boredBlockPrism(k);
      const piece = pieceOf(pr.soup, withRaw);
      // The bore wall: the first 2 x SEG triangles' hole quads, i.e. every
      // triangle whose corners all sit on the bore's radius.
      // The bore wall: every triangle whose corners all sit on the bore's
      // radius, as exact position keys in the frame each route cuts in.
      const src = withRaw ? pr.soup : soupOf(piece.geometry);
      const boreKeys = [];
      for (let t = 0; t < src.length; t += 9) {
        let onBore = true;
        for (let v = 0; v < 3 && onBore; v++) {
          const o = t + v * 3;
          const p = withRaw ? [src[o], src[o+1], src[o+2]] : [src[o], -src[o+2], src[o+1]];   // display -> raw, offset 0
          if (Math.abs(Math.hypot(p[(k + 1) % 3] - 8, p[(k + 2) % 3] - 8) - 3) > 1e-3) onBore = false;
        }
        if (onBore) boreKeys.push([pk(src, t), pk(src, t + 3), pk(src, t + 6)].join('|'));
      }
      const boreFacesIn = h => {
        const have = new Set();
        for (let t = 0; t < h.length; t += 9) have.add([pk(h, t), pk(h, t + 3), pk(h, t + 6)].join('|'));
        return boreKeys.filter(x => have.has(x)).length;
      };
      const halfSoup = (pair, side) => withRaw ? (side === 'left' ? pair.rawA : pair.rawB) : soupOf(pair[side]);
      for (const axis of ['x', 'y', 'z'].filter(a => a !== DISP_OF_RAW[k])) {
        // Raw coordinate -5 on this axis misses the bore (it spans 5..11).
        const plane = axis === 'z' ? 5 : -5;
        const label = 'block, bore along ' + DISP_OF_RAW[k].toUpperCase() + ', cut ' + axis.toUpperCase() + ' @ ' + plane +
          (withRaw ? ' (raw)' : ' (display)');
        // The piece that keeps the bore is a block with a hole through it
        // (chi 0), the other a plain block (chi 2); the cut face is one plain
        // face either way.
        const pair = cutBoth(label, pr, piece, axis, plane,
          (side, pr2) => Object.assign({}, SOLID, { chi: boreFacesIn(halfSoup(pr2, side)) ? 0 : 2 }));
        if (!pair) continue;
        const counts = ['left', 'right'].map(sd => boreFacesIn(halfSoup(pair, sd)));
        check(label + ': all ' + boreKeys.length + ' bore-wall faces kept verbatim, in one piece',
          boreKeys.length === 2 * SEG && counts.includes(boreKeys.length) && counts.includes(0), 'per piece ' + counts.join(' / '));
      }
    }
  }

  console.log('\n=== 6. closed box: a sealed cavity inside 2 mm walls (fixtures/box_cavity_30.stl) ===');
  {
    const want = stlBytes(boxCavity());
    const have = fs.readFileSync(BOX_FIXTURE);
    check('fixture on disk is the one this file builds (regenerate: node tools/nso_cut_bore_test.js --write-fixture)',
      Buffer.compare(want, have) === 0);
    const src = readSTL(BOX_FIXTURE);
    const T0 = topo(src);
    check('fixture is closed and consistent: two shells (chi ' + T0.chi + '), volume ' + T0.volume.toFixed(1) + ' mm³',
      T0.badEdge === 0 && T0.badWinding === 0 && T0.dupFaces === 0 && T0.chi === 4 &&
      Math.abs(T0.volume - (30 ** 3 - 26 ** 3)) < 1e-6 * 30 ** 3);
    const RING = 30 * 30 - 26 * 26;   // 224 mm^2: a 2 mm square ring
    for (const withRaw of [true, false]) {
      const route = withRaw ? '(raw)' : '(display)';
      console.log('  -- through the cavity, ' + route);
      for (const axis of ['x', 'y', 'z']) {
        // Each half is an open box, one surface with the cut face as its rim.
        cutBoth('box, cut ' + axis.toUpperCase() + ' @ +1.3 ' + route, null, pieceOf(src, withRaw), axis, 1.3,
          { area: RING, comps: 1, loops: 2, capChi: 0, chi: 2, probe: [0, 0] });
      }
      console.log('  -- in the wall, clear of the cavity, ' + route);
      // The cavity's faces as exact keys in the frame each route cuts in.
      const piece = pieceOf(src, withRaw);
      const frame = withRaw ? src : soupOf(piece.geometry);
      const cavity = [];
      for (let t = 0; t < frame.length; t += 9) {
        let inside = true;
        for (let c = 0; c < 9; c++) if (Math.abs(Math.abs(frame[t + c]) - BOX_IN) > 1e-4 && Math.abs(frame[t + c]) > BOX_IN) inside = false;
        if (inside) cavity.push([pk(frame, t), pk(frame, t + 3), pk(frame, t + 6)].join('|'));
      }
      const cavityIn = h => {
        const have = new Set();
        for (let t = 0; t < h.length; t += 9) have.add([pk(h, t), pk(h, t + 3), pk(h, t + 6)].join('|'));
        return cavity.filter(x => have.has(x)).length;
      };
      const halfSoup = (pair, side) => withRaw ? (side === 'left' ? pair.rawA : pair.rawB) : soupOf(pair[side]);
      for (const axis of ['x', 'y', 'z']) {
        // -13.8 +- 0.5: both kerf planes inside the -15..-13 wall.
        const label = 'box, cut ' + axis.toUpperCase() + ' @ -13.8 ' + route;
        const pair = cutBoth(label, null, piece, axis, -13.8,
          (side, pr2) => ({ area: 900, comps: 1, loops: 1, capChi: 1,
                            chi: cavityIn(halfSoup(pr2, side)) ? 4 : 2 }));   // the piece with the cavity keeps both shells
        if (!pair) continue;
        const counts = ['left', 'right'].map(sd => cavityIn(halfSoup(pair, sd)));
        check(label + ': all ' + cavity.length + ' cavity faces kept verbatim, in one piece',
          cavity.length === 12 && counts.includes(12) && counts.includes(0), 'per piece ' + counts.join(' / '));
      }
    }
  }

  console.log('\n=== 5. a cut that cannot be made right is refused, in plain words ===');
  {
    const refusal = (label, piece, axis, lo, hi, re) => {
      let err = null;
      try { splitBothSides(piece, axis, lo, hi); } catch (e) { err = e; }
      check(label + ': refused as CutRefused', !!err && err.name === 'CutRefused', err ? err.name + ': ' + err.message : 'it cut');
      if (err) check('  says why without engine jargon: "' + err.message + '"',
        re.test(err.message) && !/rawCut|branch point|bridge|degree/i.test(err.message));
    };
    // A ring with two outer-wall faces missing where the plane crosses: the
    // section's outline is open, so no cut face can close it.
    const torn = ringPrism(2).soup.slice(18);   // the first outer-wall quad, gone
    for (const withRaw of [true, false]) {
      refusal('ring with a torn wall, cut Y ' + (withRaw ? '(raw)' : '(display)'), pieceOf(torn, withRaw), 'y', 0.8, 1.8,
        /open or touches itself/);
    }
    // An inside-out piece (every face wound inward, negative volume - the
    // library's USB_bit.stl is one). rawCut caps it facing out, against its
    // walls; the old route handed back that half without a word.
    const inverted = ringPrism(2).soup.slice();
    for (let t = 0; t < inverted.length; t += 9) for (let c = 0; c < 3; c++) {
      const x = inverted[t + 3 + c]; inverted[t + 3 + c] = inverted[t + 6 + c]; inverted[t + 6 + c] = x;
    }
    for (const withRaw of [true, false]) {
      refusal('inside-out ring, cut Y ' + (withRaw ? '(raw)' : '(display)'), pieceOf(inverted, withRaw), 'y', 0.8, 1.8, /inside-out/);
    }
    refusal('plane past the end of the piece', pieceOf(ringPrism(2).soup, true), 'y', 9, 10, /nothing is left/);

    // The check that stands behind every cut face, shown the old engine's
    // answer: the walls of a ring half under a per-loop cap (disc + bore lid).
    // capFromEdges places its own points, so the seam does not even close.
    const half = Array.from(rawCut(ringPrism(2).soup, 2, 3, false));
    const walls = [];
    for (let t = 0; t < half.length; t += 9) if (!(half[t+2] === 3 && half[t+5] === 3 && half[t+8] === 3)) walls.push(...half.slice(t, t + 9));
    const edges = [];
    for (const r of [R_OUT, R_IN]) {
      const c = circle(r, 0, 0);
      for (let i = 0; i < SEG; i++) { const a = c[i], b = c[(i + 1) % SEG]; edges.push([[a[0], a[1], 3], [b[0], b[1], 3]]); }
    }
    const lidded = new Float32Array(walls.concat(Array.from(ctx.capFromEdges(edges, 'z', 3, true))));
    const why = ctx.cutFaceProblem(lidded, 2, 3);
    check('cutFaceProblem rejects a lidded bore: "' + why + '"', !!why && /covered twice|left open/.test(why));
    check('cutFaceProblem passes rawCut\'s own annulus', ctx.cutFaceProblem(new Float32Array(half), 2, 3) === null);
  }
} catch (e) {
  console.error(e);
  fail++;
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
