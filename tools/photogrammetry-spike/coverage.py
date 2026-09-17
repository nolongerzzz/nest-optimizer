#!/usr/bin/env python3
"""Azimuthal completeness of a sparse model's reconstructed surface.

Track length rewards cameras that crowd one side of an object, so it cannot on
its own tell a well-surrounded capture from a dense one-sided one. This
measures what was actually reconstructed.

The frame comes from the CAMERAS, not the points: the camera path's plane
normal is the rig's up-axis, and the object centre is the median 3D point.
(Fitting a plane to the points instead is meaningless for an upright subject -
it returns a vertical plane and every model then scores 100 %.)"""
import sys, os, json, subprocess, tempfile
import numpy as np

def qvec2rotmat(q):
    w,x,y,z=q
    return np.array([[1-2*y*y-2*z*z,2*x*y-2*z*w,2*x*z+2*y*w],
                     [2*x*y+2*z*w,1-2*x*x-2*z*z,2*y*z-2*x*w],
                     [2*x*z-2*y*w,2*y*z+2*x*w,1-2*x*x-2*y*y]])

def astxt(model_dir):
    if os.path.exists(os.path.join(model_dir,'points3D.txt')): return model_dir
    d=tempfile.mkdtemp()
    subprocess.run(['colmap','model_converter','--input_path',model_dir,
                    '--output_path',d,'--output_type','TXT'],capture_output=True)
    return d

def load(model_dir):
    d=astxt(model_dir)
    P=[]
    for l in open(os.path.join(d,'points3D.txt')):
        if l.startswith('#'): continue
        e=l.split()
        if len(e)>=4: P.append([float(e[1]),float(e[2]),float(e[3])])
    C=[]
    lines=[l for l in open(os.path.join(d,'images.txt')) if not l.startswith('#')]
    for i in range(0,len(lines),2):
        e=lines[i].split()
        if len(e)<10: continue
        R=qvec2rotmat([float(x) for x in e[1:5]]); t=np.array([float(x) for x in e[5:8]])
        C.append(-R.T@t)
    return np.array(P), np.array(C)

def report(P,C,nbins=36):
    ctr=np.median(P,axis=0)
    up=np.linalg.svd(C-C.mean(axis=0),full_matrices=False)[2][2]      # camera-plane normal
    e1=np.cross(up,[1,0,0])
    if np.linalg.norm(e1)<1e-6: e1=np.cross(up,[0,1,0])
    e1/=np.linalg.norm(e1); e2=np.cross(up,e1)
    X=P-ctr
    r=np.linalg.norm(X,axis=1)
    X=X[r<np.percentile(r,97)]                                        # trim strays
    az=np.degrees(np.arctan2(X@e2,X@e1))%360
    h,_=np.histogram(az,bins=nbins,range=(0,360))
    thresh=max(1,int(0.0025*len(X)))
    filled=int((h>=thresh).sum())
    # camera azimuths, for the gap the spec gates on
    cz=np.sort(np.degrees(np.arctan2((C-ctr)@e2,(C-ctr)@e1))%360)
    gaps=np.diff(np.concatenate([cz,[cz[0]+360]]))
    return {'points':int(len(P)),'surface_bins_filled':filled,'bins':nbins,
            'surface_completeness':round(filled/nbins,3),
            'max_camera_az_gap_deg':round(float(gaps.max()),1)}

if __name__=='__main__':
    for d in sys.argv[1:]:
        name=os.path.basename(os.path.dirname(d)) if os.path.basename(d)=='0' else os.path.basename(d)
        try: print(f"{name:<20}", json.dumps(report(*load(d))))
        except Exception as e: print(f"{name:<20} ERROR {e}")
