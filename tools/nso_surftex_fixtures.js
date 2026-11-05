'use strict';
/* Fixtures for tools/nso_surftex_test.js: closed pieces whose faces are known in closed form. Soup = 9 floats a triangle, counter-clockwise
   from outside, z up. cyl / tube / box / uvsphere are clean primitives; hills is a slab whose top is a free-form heightfield (the
   "contoured face"). Every one is watertight - the test checks them before it checks anything made from them. */
exports.cyl=function(R,H,n,z0){z0=z0||0;const t=[];const A=i=>[R*Math.cos(2*Math.PI*i/n),R*Math.sin(2*Math.PI*i/n)];
 for(let i=0;i<n;i++){const a=A(i),b=A(i+1);
  t.push(a[0],a[1],z0,b[0],b[1],z0,b[0],b[1],z0+H, a[0],a[1],z0,b[0],b[1],z0+H,a[0],a[1],z0+H);
  t.push(0,0,z0+H,a[0],a[1],z0+H,b[0],b[1],z0+H); t.push(0,0,z0,b[0],b[1],z0,a[0],a[1],z0);}
 return Float32Array.from(t);}
exports.box=function(w,d,h){const t=[];function q(a,b,c,d2){t.push(...a,...b,...c,...a,...c,...d2);}
 const x=w/2,y=d/2;const p=[[-x,-y,0],[x,-y,0],[x,y,0],[-x,y,0],[-x,-y,h],[x,-y,h],[x,y,h],[-x,y,h]];
 q(p[0],p[3],p[2],p[1]);q(p[4],p[5],p[6],p[7]);q(p[0],p[1],p[5],p[4]);q(p[1],p[2],p[6],p[5]);q(p[2],p[3],p[7],p[6]);q(p[3],p[0],p[4],p[7]);
 return Float32Array.from(t);}
exports.uvsphere=function(R,nu,nv,cz){cz=cz||0;const t=[];const P=(i,j)=>{const th=Math.PI*j/nv,ph=2*Math.PI*i/nu;return [R*Math.sin(th)*Math.cos(ph),R*Math.sin(th)*Math.sin(ph),cz+R*Math.cos(th)];};
 for(let j=0;j<nv;j++)for(let i=0;i<nu;i++){const a=P(i,j),b=P(i+1,j),c=P(i+1,j+1),d=P(i,j+1);
  if(j>0)t.push(...a,...d,...b); if(j<nv-1)t.push(...b,...d,...c);}
 return Float32Array.from(t);}
exports.tube=function(Ro,Ri,H,n){const t=[];const A=(r,i)=>[r*Math.cos(2*Math.PI*i/n),r*Math.sin(2*Math.PI*i/n)];
 for(let i=0;i<n;i++){const a=A(Ro,i),b=A(Ro,i+1),c=A(Ri,i),d=A(Ri,i+1);
  t.push(a[0],a[1],0,b[0],b[1],0,b[0],b[1],H, a[0],a[1],0,b[0],b[1],H,a[0],a[1],H);   // outer
  t.push(c[0],c[1],0,c[0],c[1],H,d[0],d[1],H, c[0],c[1],0,d[0],d[1],H,d[0],d[1],0);   // bore (faces in)
  t.push(a[0],a[1],H,b[0],b[1],H,d[0],d[1],H, a[0],a[1],H,d[0],d[1],H,c[0],c[1],H);   // top
  t.push(a[0],a[1],0,c[0],c[1],0,d[0],d[1],0, a[0],a[1],0,d[0],d[1],0,b[0],b[1],0);}  // bottom
 return Float32Array.from(t);}
// slab with a wavy top: closed, top is a free-form heightfield
exports.hills=function(w,d,n,amp,base){base=base||6;const t=[];const nx=n,ny=Math.round(n*d/w);
 const Z=(x,y)=>base+amp*Math.sin(x/9)*Math.cos(y/11)+amp*0.4*Math.sin((x+y)/5);
 const X=i=>-w/2+w*i/nx,Y=j=>-d/2+d*j/ny;
 const T=(a,b,c)=>t.push(...a,...b,...c);
 for(let i=0;i<nx;i++)for(let j=0;j<ny;j++){
  const a=[X(i),Y(j),Z(X(i),Y(j))],b=[X(i+1),Y(j),Z(X(i+1),Y(j))],c=[X(i+1),Y(j+1),Z(X(i+1),Y(j+1))],e=[X(i),Y(j+1),Z(X(i),Y(j+1))];
  T(a,b,c);T(a,c,e);}
 // bottom
 for(let i=0;i<nx;i++)for(let j=0;j<ny;j++){const a=[X(i),Y(j),0],b=[X(i+1),Y(j),0],c=[X(i+1),Y(j+1),0],e=[X(i),Y(j+1),0];T(a,c,b);T(a,e,c);}
 // sides
 for(let i=0;i<nx;i++){let x0=X(i),x1=X(i+1);
  T([x0,-d/2,0],[x1,-d/2,0],[x1,-d/2,Z(x1,-d/2)]);T([x0,-d/2,0],[x1,-d/2,Z(x1,-d/2)],[x0,-d/2,Z(x0,-d/2)]);
  T([x1,d/2,0],[x0,d/2,0],[x0,d/2,Z(x0,d/2)]);T([x1,d/2,0],[x0,d/2,Z(x0,d/2)],[x1,d/2,Z(x1,d/2)]);}
 for(let j=0;j<ny;j++){let y0=Y(j),y1=Y(j+1);
  T([w/2,y0,0],[w/2,y1,0],[w/2,y1,Z(w/2,y1)]);T([w/2,y0,0],[w/2,y1,Z(w/2,y1)],[w/2,y0,Z(w/2,y0)]);
  T([-w/2,y1,0],[-w/2,y0,0],[-w/2,y0,Z(-w/2,y0)]);T([-w/2,y1,0],[-w/2,y0,Z(-w/2,y0)],[-w/2,y1,Z(-w/2,y1)]);}
 return Float32Array.from(t);}
