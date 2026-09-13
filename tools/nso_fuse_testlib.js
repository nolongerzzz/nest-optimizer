/* Shared helpers for the fuse tests: box pieces, STL out, reporting. */
const fs = require('fs');
const path = require('path');

/* Axis-aligned box as a 12-triangle soup, outward normals.
   Every quad splits on its p0-p2 diagonal, and the -X and +X caps are
   given the same corner order, so two boxes stacked along X share a face
   with the same vertices AND the same triangulation - which is what a
   Square Cut produces and what fusion requires. */
function boxSoup(x0, y0, z0, x1, y1, z1) {
  const t = [];
  const quad = (a, b, c, d) => { t.push(...a, ...b, ...c); t.push(...a, ...c, ...d); };
  // +X cap
  quad([x1,y0,z0],[x1,y1,z0],[x1,y1,z1],[x1,y0,z1]);
  // -X cap (same p0-p2 diagonal, reversed winding)
  quad([x0,y0,z0],[x0,y0,z1],[x0,y1,z1],[x0,y1,z0]);
  // +Y / -Y
  quad([x0,y1,z0],[x0,y1,z1],[x1,y1,z1],[x1,y1,z0]);
  quad([x0,y0,z0],[x1,y0,z0],[x1,y0,z1],[x0,y0,z1]);
  // +Z / -Z
  quad([x0,y0,z1],[x1,y0,z1],[x1,y1,z1],[x0,y1,z1]);
  quad([x0,y0,z0],[x0,y1,z0],[x1,y1,z0],[x1,y0,z0]);
  return new Float32Array(t);
}

/* binary STL - float32 native, so a float32 soup round-trips losslessly */
function writeSTL(soup, file) {
  const n = (soup.length / 9) | 0;
  const buf = Buffer.alloc(84 + n * 50);
  buf.write('NSO fuse test', 0);
  buf.writeUInt32LE(n, 80);
  for (let t = 0; t < n; t++) {
    const o = t * 9, b = 84 + t * 50;
    const ux = soup[o+3]-soup[o], uy = soup[o+4]-soup[o+1], uz = soup[o+5]-soup[o+2];
    const vx = soup[o+6]-soup[o], vy = soup[o+7]-soup[o+1], vz = soup[o+8]-soup[o+2];
    let nx = uy*vz-uz*vy, ny = uz*vx-ux*vz, nz = ux*vy-uy*vx;
    const L = Math.hypot(nx, ny, nz) || 1; nx/=L; ny/=L; nz/=L;
    buf.writeFloatLE(nx, b); buf.writeFloatLE(ny, b+4); buf.writeFloatLE(nz, b+8);
    for (let k = 0; k < 9; k++) buf.writeFloatLE(soup[o+k], b+12+k*4);
    buf.writeUInt16LE(0, b+48);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buf);
  return file;
}

/* Bit-exact edge audit. The repo checker is the pass/fail authority, but it
   keys edges on coordinates rounded to 5 decimals, so it cannot tell a true
   weld from a hairline seam under 1e-5. This one uses raw bits, so a seam
   that only "looks" closed shows up as open edges here. */
function exactEdgeAudit(soup) {
  const n = (soup.length / 9) | 0, m = new Map();
  const key = (o) => soup[o] + ',' + soup[o+1] + ',' + soup[o+2];
  for (let t = 0; t < n; t++) {
    const o = t * 9, k = [key(o), key(o+3), key(o+6)];
    for (let e = 0; e < 3; e++) {
      const a = k[e], b = k[(e+1)%3];
      const ek = a < b ? a+'|'+b : b+'|'+a;
      m.set(ek, (m.get(ek) || 0) + 1);
    }
  }
  let open = 0, nm = 0;
  m.forEach(c => { if (c === 1) open++; else if (c > 2) nm++; });
  return { uniqueEdges: m.size, openEdges: open, nonManifoldEdges: nm };
}

/* Triangle-triangle intersection count (Moller interval test, plus a 2D SAT
   pass for the coplanar case).
   RECONCILIATION CANDIDATE - do not add a fourth. tools/mesh_validate.py
   (CSG thread) does the same job better: same Moller test but over a spatial
   hash rather than brute force, and it separates coplanar contact from true
   piercing. Both agree on every mesh this suite produces (0 piercing, 0
   coplanar). This JS copy exists only so the node tests need no python
   subprocess; it should collapse into mesh_validate.py at the merge-order
   regroup. tools/stl_watertight_check.py remains the watertight authority and
   covers edge parity and degeneracy only.
   Pairs sharing an edge are legal surface contact and are skipped; everything
   else must overlap with positive measure to count. */
function selfIntersections(soup) {
  const n = (soup.length / 9) | 0;
  const EPS = 1e-9;
  const sub=(a,b)=>[a[0]-b[0],a[1]-b[1],a[2]-b[2]];
  const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
  const dot=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
  const tri=(t)=>{const o=t*9;return [[soup[o],soup[o+1],soup[o+2]],[soup[o+3],soup[o+4],soup[o+5]],[soup[o+6],soup[o+7],soup[o+8]]];};
  const tris=[],boxes=[];
  for(let t=0;t<n;t++){const T=tri(t);tris.push(T);
    const lo=[1e30,1e30,1e30],hi=[-1e30,-1e30,-1e30];
    for(const p of T)for(let k=0;k<3;k++){if(p[k]<lo[k])lo[k]=p[k];if(p[k]>hi[k])hi[k]=p[k];}
    boxes.push([lo,hi]);}
  const same=(a,b)=>Math.abs(a[0]-b[0])<1e-6&&Math.abs(a[1]-b[1])<1e-6&&Math.abs(a[2]-b[2])<1e-6;
  const sharedVerts=(A,B)=>{let c=0;for(const a of A)for(const b of B)if(same(a,b)){c++;break;}return c;};

  /* 2D SAT with strict separation: touching edges do not count */
  function coplanarOverlap(A,B,N){
    const ax=Math.abs(N[0]),ay=Math.abs(N[1]),az=Math.abs(N[2]);
    let i0,i1; if(ax>ay&&ax>az){i0=1;i1=2;}else if(ay>az){i0=0;i1=2;}else{i0=0;i1=1;}
    const P=A.map(p=>[p[i0],p[i1]]),Q=B.map(p=>[p[i0],p[i1]]);
    const scale=Math.max(1,...P.flat().map(Math.abs),...Q.flat().map(Math.abs));
    const tol=1e-9*scale;
    for(const T of [P,Q]){
      for(let e=0;e<3;e++){
        const a=T[e],b=T[(e+1)%3];
        const nx=-(b[1]-a[1]),ny=b[0]-a[0];
        const L=Math.hypot(nx,ny); if(L<tol)continue;
        let p0=Infinity,p1=-Infinity,q0=Infinity,q1=-Infinity;
        for(const v of P){const d=((v[0]-a[0])*nx+(v[1]-a[1])*ny)/L;if(d<p0)p0=d;if(d>p1)p1=d;}
        for(const v of Q){const d=((v[0]-a[0])*nx+(v[1]-a[1])*ny)/L;if(d<q0)q0=d;if(d>q1)q1=d;}
        if(p1<q0+tol||q1<p0+tol)return false;
      }
    }
    return true;
  }

  /* interval of triangle T on the intersection line, given signed dists d[] */
  function interval(T,d,D){
    const proj=T.map(p=>dot(D,p));
    /* vertex alone on one side */
    let solo=-1;
    for(let i=0;i<3;i++){const a=d[i],b=d[(i+1)%3],c=d[(i+2)%3];
      if((a>0&&b<=0&&c<=0)||(a<0&&b>=0&&c>=0)){solo=i;break;}}
    if(solo<0){for(let i=0;i<3;i++)if(Math.abs(d[i])<EPS&&d[(i+1)%3]*d[(i+2)%3]>0){solo=i;break;}}
    if(solo<0)return null;
    const o=solo,p=(solo+1)%3,q=(solo+2)%3;
    const t1=proj[o]+(proj[p]-proj[o])*(d[o]/(d[o]-d[p]));
    const t2=proj[o]+(proj[q]-proj[o])*(d[o]/(d[o]-d[q]));
    return [Math.min(t1,t2),Math.max(t1,t2)];
  }

  let hits=0;
  for(let i=0;i<n;i++)for(let j=i+1;j<n;j++){
    const [l1,h1]=boxes[i],[l2,h2]=boxes[j];
    if(h1[0]<l2[0]-EPS||h2[0]<l1[0]-EPS||h1[1]<l2[1]-EPS||h2[1]<l1[1]-EPS||h1[2]<l2[2]-EPS||h2[2]<l1[2]-EPS)continue;
    const A=tris[i],B=tris[j];
    if(sharedVerts(A,B)>=2)continue;           /* shares an edge: legal contact */
    const N1=cross(sub(A[1],A[0]),sub(A[2],A[0])),d1=-dot(N1,A[0]);
    const N2=cross(sub(B[1],B[0]),sub(B[2],B[0])),d2=-dot(N2,B[0]);
    const sc=Math.max(Math.hypot(...N1),Math.hypot(...N2),1);
    const db=B.map(p=>(dot(N1,p)+d1)/sc), da=A.map(p=>(dot(N2,p)+d2)/sc);
    const tiny=1e-9*Math.max(1,...A.flat().map(Math.abs),...B.flat().map(Math.abs));
    const dbz=db.map(v=>Math.abs(v)<tiny?0:v), daz=da.map(v=>Math.abs(v)<tiny?0:v);
    if((dbz[0]>0&&dbz[1]>0&&dbz[2]>0)||(dbz[0]<0&&dbz[1]<0&&dbz[2]<0))continue;
    if((daz[0]>0&&daz[1]>0&&daz[2]>0)||(daz[0]<0&&daz[1]<0&&daz[2]<0))continue;
    if(dbz[0]===0&&dbz[1]===0&&dbz[2]===0){     /* coplanar */
      if(coplanarOverlap(A,B,N1))hits++;
      continue;
    }
    const D=cross(N1,N2);
    if(Math.hypot(...D)<EPS)continue;
    const iA=interval(A,daz,D),iB=interval(B,dbz,D);
    if(!iA||!iB)continue;
    const lo=Math.max(iA[0],iB[0]),hi=Math.min(iA[1],iB[1]);
    const span=Math.max(iA[1]-iA[0],iB[1]-iB[0]);
    if(hi-lo>1e-9*Math.max(span,1))hits++;
  }
  return hits;
}

module.exports = { boxSoup, writeSTL, exactEdgeAudit, selfIntersections };
