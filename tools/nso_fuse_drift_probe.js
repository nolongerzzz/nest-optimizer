/* How much does the live transform pipeline actually move a shared face?
   Randomised, non-float32-representable geometry, real THREE r147 math,
   Float32 storage at every stage the app stores at, and the soup->local->soup
   round trips the app performs (NSO_soupToLocal). Reports drift as a FRACTION
   of coordinate magnitude, which is the number the tolerance policy needs. */
const F = require('../nso_planar_fuse.js');
const { boxSoup } = require('./nso_fuse_testlib.js');
const THREE = require('./nso_fuse_three.js');

function geomOf(soup) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(soup), 3));
  return g;
}
function loadPipeline(raw) {
  const g = geomOf(raw);
  g.rotateX(-Math.PI/2); g.computeVertexNormals(); g.computeBoundingBox();
  const bb = g.boundingBox;
  const c = new THREE.Vector3((bb.min.x+bb.max.x)/2,(bb.min.y+bb.max.y)/2,(bb.min.z+bb.max.z)/2);
  g.center(); g.center();
  return { geom: g, centerOffset: c };
}
function worldSoup(mesh) {
  mesh.updateWorldMatrix(true,false);
  const m = mesh.matrixWorld, pos = mesh.geometry.attributes.position;
  const out = new Float32Array(pos.count*3), v = new THREE.Vector3();
  for (let i=0;i<pos.count;i++){v.set(pos.getX(i),pos.getY(i),pos.getZ(i)).applyMatrix4(m);out[i*3]=v.x;out[i*3+1]=v.y;out[i*3+2]=v.z;}
  return out;
}
function soupToLocal(ws, mesh) { /* app.js NSO_soupToLocal, Float32 out */
  mesh.updateWorldMatrix(true,false);
  const inv = new THREE.Matrix4().copy(mesh.matrixWorld).invert();
  const out = new Float32Array(ws.length), v = new THREE.Vector3();
  for (let i=0;i<ws.length;i+=3){v.set(ws[i],ws[i+1],ws[i+2]).applyMatrix4(inv);out[i]=v.x;out[i+1]=v.y;out[i+2]=v.z;}
  return out;
}

let rs = 20260913;
const rnd = () => (rs = (rs*1103515245+12345)&0x7fffffff) / 0x7fffffff;

function trial(roundTrips) {
  const L = 7+rnd()*23, W = 3+rnd()*17, H = 3+rnd()*17;   /* not float32-round */
  const rawA = boxSoup(0,0,0,L,W,H), rawB = boxSoup(L,0,0,2*L,W,H);
  const pa = loadPipeline(rawA), pb = loadPipeline(rawB);
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(
    (rnd()*2-1)*Math.PI, (rnd()*2-1)*Math.PI, (rnd()*2-1)*Math.PI));
  const sc = 0.4+rnd()*2.5;
  const t = new THREE.Vector3((rnd()*2-1)*400,(rnd()*2-1)*400,(rnd()*2-1)*400);
  const mk = (p) => {
    const m = new THREE.Mesh(p.geom);
    m.quaternion.copy(q); m.scale.set(sc,sc,sc);
    const c = p.centerOffset.clone().multiplyScalar(sc).applyQuaternion(q);
    m.position.set(c.x+t.x, c.y+t.y, c.z+t.z);
    m.updateWorldMatrix(true,false);
    return m;
  };
  let mA = mk(pa), mB = mk(pb);
  let sA = worldSoup(mA), sB = worldSoup(mB);
  /* round trip world->local->world, as the app does between operations */
  for (let k = 0; k < roundTrips; k++) {
    const lA = soupToLocal(sA, mA), lB = soupToLocal(sB, mB);
    mA = new THREE.Mesh(geomOf(lA)); mA.quaternion.copy(q); mA.scale.set(sc,sc,sc); mA.position.copy(mk(pa).position);
    mB = new THREE.Mesh(geomOf(lB)); mB.quaternion.copy(q); mB.scale.set(sc,sc,sc); mB.position.copy(mk(pb).position);
    sA = worldSoup(mA); sB = worldSoup(mB);
  }
  /* Drift measured on KNOWN correspondences, not nearest-neighbour guessing:
     in raw space the shared face is x==L, and a vertex of A at (L,y,z) is the
     same physical point as the vertex of B at (L,y,z). Match those index pairs
     in the raw soups, then compare the same indices after the pipeline. */
  const pairIdx = [];
  for (let i = 0; i < rawA.length; i += 3) {
    if (rawA[i] !== L) continue;
    for (let j = 0; j < rawB.length; j += 3) {
      if (rawB[j] === L && rawB[j+1] === rawA[i+1] && rawB[j+2] === rawA[i+2]) { pairIdx.push([i, j]); break; }
    }
  }
  let worst = 0, maxAbs = 0;
  for (let i=0;i<sA.length;i++) maxAbs = Math.max(maxAbs, Math.abs(sA[i]));
  for (let i=0;i<sB.length;i++) maxAbs = Math.max(maxAbs, Math.abs(sB[i]));
  for (const [i, j] of pairIdx) {
    const d = Math.hypot(sA[i]-sB[j], sA[i+1]-sB[j+1], sA[i+2]-sB[j+2]);
    if (d > worst) worst = d;
  }
  const ti = F.NSO_fuseTolerance([sA,sB]);
  const r = F.NSO_planarFusePair(sA,sB);
  return { worst, maxAbs, nPairs: pairIdx.length, rel: worst/Math.max(maxAbs,1e-9), tol: ti.tol, fused: r.ok, reason: r.reason, scale: ti.scale };
}

for (const rt of [0, 1, 3, 10]) {
  const N = 200;
  let worstRel = 0, worstAbs = 0, fusedN = 0, fails = [];
  const rels = [];
  rs = 20260913;
  for (let i=0;i<N;i++){
    const t = trial(rt);
    rels.push(t.rel);
    if (t.rel > worstRel) worstRel = t.rel;
    if (t.worst > worstAbs) worstAbs = t.worst;
    if (t.fused) fusedN++; else fails.push(t.reason);
  }
  rels.sort((a,b)=>a-b);
  console.log(`round trips ${String(rt).padStart(2)} | ${N} trials | fused ${fusedN}/${N}` +
    ` | drift max ${worstAbs.toExponential(3)}mm` +
    ` | drift/magnitude: median ${rels[N>>1].toExponential(2)}, p99 ${rels[Math.floor(N*0.99)].toExponential(2)}, max ${worstRel.toExponential(2)}`);
  if (fails.length) console.log('     first refusal:', fails[0]);
}
console.log('\nrelEps currently', F.NSO_fuseTolerance([new Float32Array([0,0,0,1,0,0,0,1,0])]).relEps);
