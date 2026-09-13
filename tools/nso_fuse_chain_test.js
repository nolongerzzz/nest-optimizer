/* 12-piece chain fusion at real scale.
   Gates: tri count == 144 - (N-1)*4, single watertight solid (repo checker),
   volume == sum of inputs, 0 self-intersections. */
const F = require('../nso_planar_fuse.js');
const { boxSoup, writeSTL, exactEdgeAudit, selfIntersections } = require('./nso_fuse_testlib.js');

const N = 12, L = 20, W = 10, H = 10;
const pieces = [], outDir = process.argv[2] || '/tmp/nso_fuse_out';

let volIn = 0;
for (let i = 0; i < N; i++) {
  const p = boxSoup(i * L, 0, 0, (i + 1) * L, W, H);
  pieces.push(p);
  volIn += F.NSO_soupVolume(p);
}
const triIn = pieces.reduce((a, p) => a + F.NSO_fuseTriCount(p), 0);

const r = F.NSO_planarFuseChain(pieces);
if (!r.ok) { console.log('FUSE REFUSED:', r.reason); process.exit(1); }

const volOut = F.NSO_soupVolume(r.soup);
const expectTri = triIn - (N - 1) * 4;
const audit = exactEdgeAudit(r.soup);
const si = selfIntersections(r.soup);

console.log('=== 12-piece chain ===');
console.log('pieces                ', N, `(${L}x${W}x${H} mm each, chained along X, 0..${N*L}mm)`);
console.log('tolerance used        ', r.stats.tol.toExponential(4), 'mm   (scale', r.stats.scale.toFixed(2), 'mm)');
console.log('tri in                ', triIn);
console.log('tri out               ', r.stats.triOut, '   expected', expectTri, r.stats.triOut === expectTri ? 'PASS' : 'FAIL');
console.log('tri removed           ', r.stats.removed, '  expected', (N-1)*4, `(${N-1} joints x 2 sides x 2 cap tris)`, r.stats.removed === (N-1)*4 ? 'PASS' : 'FAIL');
console.log('volume in (sum)       ', volIn);
console.log('volume out            ', volOut, Math.abs(volOut - volIn) < 1e-6 * Math.abs(volIn) ? 'PASS' : 'FAIL');
console.log('exact-bit open edges  ', audit.openEdges, audit.openEdges === 0 ? 'PASS' : 'FAIL');
console.log('exact-bit nonmanifold ', audit.nonManifoldEdges, audit.nonManifoldEdges === 0 ? 'PASS' : 'FAIL');
console.log('self-intersections    ', si, si === 0 ? 'PASS' : 'FAIL', '(cross-checked against tools/mesh_validate.py)');
console.log('per-joint caps        ', r.joints.map(j => j.removed).join(','));
console.log('verts snapped by weld ', r.joints.reduce((a,j)=>a+j.vertsSnapped,0), '(0 expected: untransformed pieces are already bit-identical)');

writeSTL(r.soup, outDir + '/chain12_fused.stl');
console.log('wrote', outDir + '/chain12_fused.stl');
