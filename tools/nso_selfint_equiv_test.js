/* Cross-language equivalence test for the canonical self-intersection checker.
 *
 * There are two implementations and there have to be: tools/mesh_validate.py is
 * the canonical definition of the policy, and NSO_Repair.js needs the same test
 * in the browser, where it cannot shell out to python. Two implementations of
 * one policy is exactly how the three copies this consolidation retired came to
 * disagree, so this test exists to make drift a build failure rather than a
 * discovery six months later.
 *
 * It asserts, on every STL in the repo:
 *   - identical piercing counts
 *   - identical coplanar counts
 *   - identical welded-vertex and open-edge counts (the weld feeds adjacency,
 *     so the two cannot agree on intersections by accident if they disagree here)
 *
 * It also pins the policy itself with cases built to separate the options that
 * were open before the consolidation. Those are not regression noise: each one
 * fails if someone flips a policy back.
 *
 *   node tools/nso_selfint_equiv_test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { readSTL, loadRepairModule } = require('./nso_stl_io.js');

const ROOT = path.join(__dirname, '..');
const R = loadRepairModule(path.join(ROOT, 'NSO_Repair.js'));
const MV = path.join(ROOT, 'tools', 'mesh_validate.py');

let pass = 0, fail = 0;
function ok(cond, label, detail) {
  if (cond) { pass++; console.log('  ok    ' + label); }
  else { fail++; console.log('  FAIL  ' + label + (detail ? '\n          ' + detail : '')); }
}

/* ------------------------------------------------------------ cross-language */

function pyValidate(file) {
  const out = execFileSync('python3', [MV, file, '--json'], { maxBuffer: 1 << 28 });
  return JSON.parse(out.toString());
}

function stlsUnder(dir) {
  const out = [];
  (function walk(d) {
    let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.toLowerCase().endsWith('.stl')) out.push(p);
    }
  })(dir);
  return out.sort();
}

console.log('cross-language equivalence: NSO_Repair.js vs tools/mesh_validate.py');
const files = [].concat(stlsUnder(path.join(ROOT, 'fixtures')),
                        stlsUnder(path.join(ROOT, 'library')));
if (!files.length) { console.log('  no STL fixtures found'); fail++; }

for (const f of files) {
  const rel = path.relative(ROOT, f);
  let soup;
  try { soup = readSTL(f); } catch (e) { console.log('  skip  ' + rel + ' (' + e.message + ')'); continue; }
  if (soup.length === 0) { console.log('  skip  ' + rel + ' (empty)'); continue; }

  const js = R.inspect(soup);
  const py = pyValidate(f);
  const si = py.self_intersection;

  const got = `${js.selfIntersections}/${js.selfIntersectionsCoplanar}`;
  const want = `${si.pierce}/${si.coplanar}`;
  ok(got === want, `${rel} — selfint pierce/coplanar ${want}`,
     got !== want ? `NSO_Repair.js ${got}, mesh_validate.py ${want}` : null);

  ok(js.openEdges === py.open_edges,
     `${rel} — open edges ${py.open_edges}`,
     js.openEdges !== py.open_edges ? `NSO_Repair.js ${js.openEdges}, mesh_validate.py ${py.open_edges}` : null);
}

/* ------------------------------------------------------------- policy pinning */

console.log('\npolicy: endpoint touch is contact, not penetration');

/* A is the triangle x>=0, y>=0, x+y<=10 in the plane z=0. Along the line
 * {y=2, z=0} it occupies x in [0, 8]. B rests its bottom edge on z=0 spanning
 * [b0, b0+3], so sliding b0 across 8 walks through the exact-touch case — the
 * only configuration where a strict and an epsilon-tolerant endpoint test can
 * disagree. No existing fixture reaches it; these were built to. */
const A = [0,0,0, 10,0,0, 0,10,0];
const B = (b0) => [b0,2,0, b0+3,2,0, b0+1.5,2,4];
const pairSoup = (t1, t2) => new Float32Array(t1.concat(t2));

function pierceOf(soup) { return R._selfIntersectionDetail(R._weldToIndexed(soup, 1e-4).mesh).pierce; }

ok(pierceOf(pairSoup(A, B(5.0))) === 1,
   'overlap of 3.0 mm is a pierce');
ok(pierceOf(pairSoup(A, B(8.0))) === 0,
   'exact endpoint touch, zero overlap, is NOT a pierce');
ok(pierceOf(pairSoup(A, B(8.0 - 1e-12))) === 0,
   'overlap of 1e-12 mm is NOT a pierce (float32 ULP at 8 mm is 9.5e-7)');
ok(pierceOf(pairSoup(A, B(8.0 + 1e-12))) === 0,
   'gap of 1e-12 mm is NOT a pierce');
ok(pierceOf(pairSoup(A, B(8.5))) === 0,
   'gap of 0.5 mm is NOT a pierce');

console.log('\npolicy: the predicate is symmetric in its two triangles');

/* Triangles 21845 and 22092 of library/tape_on-edge-single-B101_rounded_v8_FINAL.stl,
 * welded at 1e-4. They are nearly coplanar and wildly different in size, and
 * they are the pair that exposed the bug: mesh_validate.py as it stood before
 * this consolidation answered 'coplanar' for (a, b) and None for (b, a),
 * because it zeroed plane distances against an absolute epsilon without
 * dividing by the normal's length. The small triangle's unnormalised normal is
 * tiny, so distances measured against ITS plane vanished and distances
 * measured against the large one's did not. The uniform hash and the BVH visit
 * unordered pairs in different orders, so the two implementations landed on
 * different answers — 7 coplanar against 6 on this file. Real coordinates, not
 * a constructed case. */
const tapeA = [-38.900001525878906, -0.03673261031508446, 9.896341323852539,
               -38.900001525878906, -0.09466113895177841, 9.997164726257324,
               -38.900001525878906, -0.10793165117502213, 10.020261764526367];
const tapeB = [-38.900001525878906, 0.034392327070236206, 9.674921989440918,
               -40.074275970458984, 0.034392327070236206, 9.674921989440918,
               -40.074275970458984, -0.09466113895177841, 9.997164726257324];
const fwd = JSON.stringify(R._selfIntersectionDetail(R._weldToIndexed(pairSoup(tapeA, tapeB), 1e-4).mesh));
const rev = JSON.stringify(R._selfIntersectionDetail(R._weldToIndexed(pairSoup(tapeB, tapeA), 1e-4).mesh));
ok(fwd === rev, `tape tris 21845/22092 give the same answer either way round (${fwd} === ${rev})`,
   fwd !== rev ? `forward ${fwd}, reversed ${rev}` : null);

/* And the same pair through the predicate directly, both orders. */
const triA = [tapeA.slice(0,3), tapeA.slice(3,6), tapeA.slice(6,9)];
const triB = [tapeB.slice(0,3), tapeB.slice(3,6), tapeB.slice(6,9)];
const pf = R._triTriIntersect(triA[0], triA[1], triA[2], triB[0], triB[1], triB[2]);
const pr = R._triTriIntersect(triB[0], triB[1], triB[2], triA[0], triA[1], triA[2]);
ok(pf === pr, `tape tris 21845/22092 through triTriIntersect both ways (${pf} === ${pr})`,
   pf !== pr ? `forward ${pf}, reversed ${pr}` : null);

console.log('\npolicy: adjacency weld is a radius weld at 1e-4, not a snap at 1e-5');

/* fixtures/repair/synth_near_dup_vertex.stl is a closed box carrying one
 * near-duplicate vertex. Below ~5e-5 the duplicate does not weld, the box reads
 * as open, and the checker reports piercing pairs that are not there. */
const ndv = path.join(ROOT, 'fixtures', 'repair', 'synth_near_dup_vertex.stl');
if (fs.existsSync(ndv)) {
  const raw = readSTL(ndv);
  const atDefault = R.inspect(raw);
  const atTight = R.inspect(raw, { weldTol: 1e-5 });
  ok(atDefault.selfIntersections === 0 && atDefault.openEdges === 0,
     'synth_near_dup_vertex at the default 1e-4: closed, 0 piercing',
     `got selfInt ${atDefault.selfIntersections}, open ${atDefault.openEdges}`);
  ok(atTight.selfIntersections > 0,
     'synth_near_dup_vertex at 1e-5: the false positives the default avoids ' +
     `(${atTight.selfIntersections} piercing, ${atTight.openEdges} open edges)`);
} else {
  console.log('  skip  synth_near_dup_vertex.stl not present');
}

console.log('\n' + '-'.repeat(58));
console.log(`${pass} passed, ${fail} failed`);
console.log(fail ? 'FAIL' : 'PASS');
process.exit(fail ? 1 : 0);
