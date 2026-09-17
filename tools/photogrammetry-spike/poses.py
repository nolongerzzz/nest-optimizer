#!/usr/bin/env python3
"""Read a COLMAP sparse model (TXT), compute camera centres and the azimuth /
elevation of each camera about the reconstructed object centroid."""
import sys, os, math, json
import numpy as np

def qvec2rotmat(q):
    w,x,y,z = q
    return np.array([
        [1-2*y*y-2*z*z, 2*x*y-2*z*w,   2*x*z+2*y*w],
        [2*x*y+2*z*w,   1-2*x*x-2*z*z, 2*y*z-2*x*w],
        [2*x*z-2*y*w,   2*y*z+2*x*w,   1-2*x*x-2*y*y]])

def read_images(p):
    out={}
    with open(p) as f:
        lines=[l for l in f if not l.startswith('#')]
    for i in range(0,len(lines),2):
        e=lines[i].split()
        if len(e)<10: continue
        iid=int(e[0]); q=np.array([float(x) for x in e[1:5]]); t=np.array([float(x) for x in e[5:8]])
        name=e[9]
        R=qvec2rotmat(q); C=-R.T@t
        npts=len([x for x in lines[i+1].split()])//3
        out[name]={'id':iid,'C':C.tolist(),'R':R.tolist(),'n_obs':npts}
    return out

def read_points(p):
    xs=[]
    with open(p) as f:
        for l in f:
            if l.startswith('#'): continue
            e=l.split()
            if len(e)<4: continue
            xs.append([float(e[1]),float(e[2]),float(e[3])])
    return np.array(xs)

def main(model_dir, out_json):
    imgs=read_images(os.path.join(model_dir,'images.txt'))
    pts=read_points(os.path.join(model_dir,'points3D.txt'))
    # robust object centre: median of the 3D points
    ctr=np.median(pts,axis=0)
    C=np.array([imgs[k]['C'] for k in imgs])
    # fit the dominant capture plane: normal = smallest-singular-value direction
    X=C-C.mean(axis=0)
    u,s,vt=np.linalg.svd(X,full_matrices=False)
    up=vt[2]                      # plane normal == rig "up"
    e1=vt[0]; e2=vt[1]
    rows=[]
    for name,d in imgs.items():
        v=np.array(d['C'])-ctr
        az=math.degrees(math.atan2(float(v@e2),float(v@e1)))%360.0
        r=float(np.linalg.norm(v))
        el=math.degrees(math.asin(max(-1,min(1,float(v@up)/r))))
        rows.append({'name':name,'id':d['id'],'az':az,'el':el,'dist':r,'n_obs':d['n_obs']})
    rows.sort(key=lambda r:r['az'])
    res={'n_images':len(rows),'n_points':len(pts),
         'centroid':ctr.tolist(),'plane_sv':s.tolist(),'rows':rows}
    json.dump(res,open(out_json,'w'),indent=1)
    print(f"{len(rows)} cameras, {len(pts)} points; SVD singular values {s.round(3).tolist()}")
    print(f"{'name':<16}{'az':>8}{'el':>8}{'dist':>9}{'obs':>7}")
    prev=None
    for r in rows:
        gap = '' if prev is None else f"  (+{r['az']-prev:.1f} deg)"
        print(f"{r['name']:<16}{r['az']:8.1f}{r['el']:8.1f}{r['dist']:9.3f}{r['n_obs']:7d}{gap}")
        prev=r['az']
    gaps=[rows[(i+1)%len(rows)]['az']-rows[i]['az'] for i in range(len(rows)-1)]
    gaps.append((rows[0]['az']+360)-rows[-1]['az'])
    import statistics
    print(f"\nazimuth step: mean {statistics.mean(gaps):.1f} deg  median {statistics.median(gaps):.1f}  max {max(gaps):.1f}")
    print(f"elevation range: {min(r['el'] for r in rows):.1f} .. {max(r['el'] for r in rows):.1f} deg")

if __name__=='__main__':
    main(sys.argv[1], sys.argv[2])
