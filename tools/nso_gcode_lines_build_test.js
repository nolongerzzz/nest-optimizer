#!/usr/bin/env node
/* buildLineGeometry (nso-gcode-lines.js) writes its prisms straight into a
   Float32Array. It must hand back exactly what the old way did - every move
   through extrudeFlatLine into one JS array, copied into a Float32Array at the
   end - value for value, and the same move ids: G-scope's plate 2, Export and
   the crop all read it.

   Both ways are run on every move of the two committed real slices and on the
   edge cases (a zero-length move, no width, no height, a move with no index),
   and compared bit for bit. The time of each is printed.

     node tools/nso_gcode_lines_build_test.js     exit 0 = identical          */

const path = require('path');
const fs = require('fs');
const G = require(path.join(__dirname, '..', 'nso-gcode-lines.js'));

let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail ? ' - ' + detail : ''));
  if (!cond) fails++;
};

/* the old buildLineGeometry, as it was */
function oldBuild(moves) {
  const acc = [], ids = [];
  for (let i = 0; i < moves.length; i++) {
    const before = acc.length;
    G.extrudeFlatLine(moves[i], acc);
    if (acc.length > before) ids.push(moves[i].index);
  }
  return { positions: new Float32Array(acc), moveIds: new Int32Array(ids), trisPerMove: 12 };
}

function same(a, b) {
  if (a.positions.length !== b.positions.length || a.moveIds.length !== b.moveIds.length || a.trisPerMove !== b.trisPerMove) return 'lengths differ';
  const ua = new Uint32Array(a.positions.buffer, a.positions.byteOffset, a.positions.length);
  const ub = new Uint32Array(b.positions.buffer, b.positions.byteOffset, b.positions.length);
  for (let i = 0; i < ua.length; i++) if (ua[i] !== ub[i]) return 'position ' + i + ': ' + a.positions[i] + ' vs ' + b.positions[i];
  for (let i = 0; i < a.moveIds.length; i++) if (a.moveIds[i] !== b.moveIds[i]) return 'move id ' + i;
  return null;
}

(async () => {
  console.log('\n=== edge cases ===');
  const edge = [
    { x0: 0, y0: 0, x1: 10, y1: 0, z: 0.2, width: 0.45, height: 0.2, index: 0 },
    { x0: 1, y0: 1, x1: 1, y1: 1, z: 0.2, width: 0.45, height: 0.2, index: 1 },        // zero length
    { x0: 0, y0: 0, x1: 3, y1: 4, z: 0.4, width: 0, height: 0.2, index: 2 },           // no width
    { x0: 0, y0: 0, x1: 3, y1: 4, z: 0.4, width: 0.4, height: 0, index: 3 },           // no height
    { x0: -5.123, y0: 7.77, x1: 2.5, y1: -3.1, z: 1.0, width: 0.42, height: 0.16 },    // no index
    { x0: 100.001, y0: 100.002, x1: 100.0011, y1: 100.0021, z: 3, width: 0.5, height: 0.1, index: 5 }
  ];
  const e = same(G.buildLineGeometry(edge), oldBuild(edge));
  check('edge cases: identical to the old build', !e, e || '');
  check('empty: no prisms', G.buildLineGeometry([]).positions.length === 0 && G.buildLineGeometry([]).moveIds.length === 0);

  for (const name of ['tabletop.gcode.3mf', 'supportwithinsupport.gcode.3mf']) {
    const file = path.join(__dirname, '..', 'fixtures', '3mf', name);
    if (!fs.existsSync(file)) { check(name + ' is there', false); continue; }
    console.log('\n=== ' + name + ' ===');
    const res = await G.readSlicedGcode3MF(new Uint8Array(fs.readFileSync(file)), { name });
    const moves = res.parsed.moves;
    let t = process.hrtime.bigint();
    const a = G.buildLineGeometry(moves);
    const tNew = Number(process.hrtime.bigint() - t) / 1e6;
    t = process.hrtime.bigint();
    const b = oldBuild(moves);
    const tOld = Number(process.hrtime.bigint() - t) / 1e6;
    const d = same(a, b);
    check(name + ': every move (' + moves.length + ') - identical to the old build, bit for bit', !d, d || a.positions.length / 9 + ' triangles');
    console.log('  time: ' + tNew.toFixed(0) + ' ms (was ' + tOld.toFixed(0) + ' ms)');
  }
  console.log(fails ? '\n' + fails + ' check(s) FAILED' : '\nevery check held');
  process.exitCode = fails ? 1 : 0;
})();
