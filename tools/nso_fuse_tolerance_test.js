/* Congruence-tolerance suite for nso_planar_fuse.js.
   Four outcomes, not two: fused correctly / correctly declined /
   incorrectly fused / incorrectly declined. */
const path = require('path');
const F = require('../nso_planar_fuse.js');
const { boxSoup, exactEdgeAudit, selfIntersections } = require('./nso_fuse_testlib.js');
const THREE = require('./nso_fuse_three.js');

const W = 10, H = 10, L = 20;
const results = [];

function verdict(name, r, shouldFuse, note) {
  const fused = r.ok;
  let out;
  if (fused && shouldFuse) out = 'fused correctly';
  else if (!fused && !shouldFuse) out = 'correctly declined';
  else if (fused && !shouldFuse) out = 'INCORRECTLY FUSED';
  else out = 'INCORRECTLY DECLINED';
  results.push({ name, out, note: note || (r.ok ? '' : r.reason) });
  return out;
}

/* shift every occurrence of vertex `from` in a soup to `to` */
function moveVertex(soup, from, to, tol) {
  const s = new Float32Array(soup);
  let n = 0;
  for (let i = 0; i < s.length; i += 3) {
    if (Math.abs(s[i]-from[0])<tol && Math.abs(s[i+1]-from[1])<tol && Math.abs(s[i+2]-from[2])<tol) {
      s[i]=to[0]; s[i+1]=to[1]; s[i+2]=to[2]; n++;
    }
  }
  return { soup: s, moved: n };
}
function translate(soup, dx, dy, dz) {
  const s = new Float32Array(soup);
  for (let i = 0; i < s.length; i += 3) { s[i]+=dx; s[i+1]+=dy; s[i+2]+=dz; }
  return s;
}

/* ---------- CASE 1: exact congruent control ---------- */
const A = boxSoup(0,0,0,L,W,H), B = boxSoup(L,0,0,2*L,W,H);
const tolInfo = F.NSO_fuseTolerance([A,B]);
console.log('tolerance for the two-box rig:', tolInfo.tol.toExponential(4), 'mm  (scale', tolInfo.scale.toFixed(3), 'mm, relEps', tolInfo.relEps, ')');
console.log('');
const r1 = F.NSO_planarFusePair(A, B);
const audit1 = r1.ok ? exactEdgeAudit(r1.soup) : null;
console.log('--- CASE 1: exact congruent (regression control) ---');
console.log('  ', verdict('1. exact congruent', r1, true));
if (r1.ok) {
  const vA = F.NSO_soupVolume(A), vB = F.NSO_soupVolume(B), vO = F.NSO_soupVolume(r1.soup);
  console.log('   tris', r1.stats.triIn, '->', r1.stats.triOut, '(removed', r1.stats.removed + ')');
  console.log('   volume', vA, '+', vB, '=', vA+vB, ' fused:', vO, Math.abs(vO-(vA+vB))<1e-9 ? 'exact' : 'MISMATCH');
  console.log('   open edges', audit1.openEdges, ' nonmanifold', audit1.nonManifoldEdges, ' self-int', selfIntersections(r1.soup));
}

/* ---------- CASE 2: near-miss, must reject ---------- */
console.log('\n--- CASE 2: near-miss (different face, must decline) ---');
console.log('   2a axial gap: piece B pushed along X so the faces are parallel but not the same plane');
const gaps = [0.01, 0.005, 0.001, tolInfo.tol*2, tolInfo.tol*1.01, tolInfo.tol*0.99, tolInfo.tol*0.5];
for (const g of gaps) {
  const Bg = translate(B, g, 0, 0);
  const r = F.NSO_planarFusePair(A, Bg, { tolInfo });
  const exp = g > tolInfo.tol;
  const v = verdict(`2a. axial gap ${g.toExponential(3)}mm`, r, !exp, exp ? 'should decline' : 'inside tol, accept expected');
  console.log(`   gap ${g.toExponential(3)} mm  (${(g/tolInfo.tol).toFixed(2)}x tol) -> ${v}`);
}
console.log('   2b in-plane shear: B\'s whole body slid in Y, faces coplanar but not the same rectangle');
for (const g of [0.01, 0.001, tolInfo.tol*2]) {
  const Bs = translate(B, 0, g, 0);
  const r = F.NSO_planarFusePair(A, Bs, { tolInfo });
  console.log(`   shear ${g.toExponential(3)} mm (${(g/tolInfo.tol).toFixed(2)}x tol) -> ${verdict(`2b. shear ${g.toExponential(3)}mm`, r, false)}`);
}

/* ---------- CASE 3: real transform drift, must accept ---------- */
console.log('\n--- CASE 3: drift through the live rotate/center/translate pipeline ---');
function toGeometry(soup) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(soup), 3));
  return g;
}
/* app-core.js handleFiles: rotateX(-PI/2) -> center(); addModel: center() again */
function loadPipeline(rawSoup) {
  const g = toGeometry(rawSoup);
  g.rotateX(-Math.PI / 2);
  g.computeVertexNormals();
  g.computeBoundingBox();
  const bb = g.boundingBox;
  const centerOffset = new THREE.Vector3((bb.min.x+bb.max.x)/2, (bb.min.y+bb.max.y)/2, (bb.min.z+bb.max.z)/2);
  g.center();
  g.center();               /* addModel centers a second time */
  return { geom: g, centerOffset };
}
/* app-join.js meshToWorldSoup -> Float32Array */
function meshToWorldSoup(mesh) {
  mesh.updateWorldMatrix(true, false);
  const m = mesh.matrixWorld;
  const pos = mesh.geometry.attributes.position;
  const out = new Float32Array(pos.count * 3);
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.set(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(m);
    out[i*3]=v.x; out[i*3+1]=v.y; out[i*3+2]=v.z;
  }
  return out;
}
/* two halves of ONE cut, each independently loaded+centered, then placed
   back together under a shared rotation and a plate translation */
function driveDrift(rotXdeg, rotYdeg, rotZdeg, tx, ty, tz) {
  const rawA = boxSoup(0,0,0,L,W,H), rawB = boxSoup(L,0,0,2*L,W,H);
  const pa = loadPipeline(rawA), pb = loadPipeline(rawB);
  const euler = new THREE.Euler(rotXdeg*Math.PI/180, rotYdeg*Math.PI/180, rotZdeg*Math.PI/180);
  const q = new THREE.Quaternion().setFromEuler(euler);
  const mk = (p) => {
    const mesh = new THREE.Mesh(p.geom);
    mesh.quaternion.copy(q);
    /* rigid placement: rotate the piece's own centre, then translate */
    const c = p.centerOffset.clone().applyQuaternion(q);
    mesh.position.set(c.x+tx, c.y+ty, c.z+tz);
    return mesh;
  };
  return [meshToWorldSoup(mk(pa)), meshToWorldSoup(mk(pb))];
}
/* worst per-vertex disagreement on the shared plane */
function seamDrift(sA, sB) {
  const grid = F.NSO_fuseVertGrid(1.0);
  const ptsA = [];
  for (let i = 0; i < sA.length; i += 3) ptsA.push([sA[i],sA[i+1],sA[i+2]]);
  let worst = 0, pairs = 0;
  for (let i = 0; i < sB.length; i += 3) {
    const b = [sB[i],sB[i+1],sB[i+2]];
    let best = Infinity;
    for (const a of ptsA) { const d = Math.hypot(a[0]-b[0],a[1]-b[1],a[2]-b[2]); if (d<best) best=d; }
    if (best < 0.5) { pairs++; if (best>worst) worst=best; }
  }
  return { worst, pairs };
}
const scenarios = [
  ['identity (no rotate, no translate)', 0,0,0, 0,0,0],
  ['rotY 90deg, on plate', 0,90,0, 0,0,0],
  ['rotY 37deg + translate (120,15,-80)', 0,37,0, 120,15,-80],
  ['rot (17,43,29)deg + translate (250,40,310)', 17,43,29, 250,40,310],
  ['rot (17,43,29)deg + far translate (1500,200,-1800)', 17,43,29, 1500,200,-1800],
];
for (const [label,rx,ry,rz,tx,ty,tz] of scenarios) {
  const [sA,sB] = driveDrift(rx,ry,rz,tx,ty,tz);
  const d = seamDrift(sA,sB);
  const ti = F.NSO_fuseTolerance([sA,sB]);
  const r = F.NSO_planarFusePair(sA,sB);
  const v = verdict(`3. drift: ${label}`, r, true);
  let extra = '';
  if (r.ok) {
    const vol = F.NSO_soupVolume(r.soup), volIn = F.NSO_soupVolume(sA)+F.NSO_soupVolume(sB);
    const au = exactEdgeAudit(r.soup);
    extra = ` | tris ${r.stats.triIn}->${r.stats.triOut} | open ${au.openEdges} | snapped ${r.stats.vertsSnapped} (max ${r.stats.maxSnapDist.toExponential(2)}) | vol err ${(Math.abs(vol-volIn)/Math.abs(volIn)).toExponential(2)}`;
  }
  console.log(`   ${label}`);
  console.log(`     measured seam drift ${d.worst.toExponential(3)} mm | tol ${ti.tol.toExponential(3)} mm | drift/tol ${(d.worst/ti.tol).toFixed(4)} -> ${v}${extra}`);
}

/* ---------- CASE 4: one vertex off, rest exact ---------- */
console.log('\n--- CASE 4: one vertex nudged, same triangulation, rest exact ---');
console.log('   corner (x=20,y=10,z=0) appears in only ONE of B\'s two cap triangles,');
console.log('   so a non-holistic check would still see a perfect match on the other.');
for (const mult of [4, 2, 1.5, 1.01, 0.99, 0.5, 0.1]) {
  const d = tolInfo.tol * mult;
  const mv = moveVertex(B, [L, W, 0], [L, W + d, 0], 1e-6);
  const r = F.NSO_planarFusePair(A, mv.soup, { tolInfo });
  const shouldFuse = mult < 1;
  const v = verdict(`4. one vertex off ${mult}x tol`, r, shouldFuse);
  console.log(`   nudge ${d.toExponential(3)} mm (${mult}x tol, ${mv.moved} occurrences moved) -> ${v}`);
}

/* ---------- summary ---------- */
console.log('\n=== SUMMARY ===');
let bad = 0;
for (const r of results) {
  const flag = r.out.startsWith('INCORRECT') ? ' <<<' : '';
  if (flag) bad++;
  console.log(`  ${r.out.padEnd(20)} ${r.name}${flag}`);
}
console.log(`\n${results.length} cases, ${bad} wrong-direction outcome(s).`);
process.exit(bad ? 1 : 0);
