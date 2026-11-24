import numpy as np, sys
from scipy.spatial import cKDTree
from PIL import Image
from scipy import ndimage as ndi
P=np.load('rel3d_P.npy'); N=np.load('rel3d_N.npy'); h=np.load('rel3d_h.npy')
R=float(sys.argv[1]) if len(sys.argv)>1 else 1.6
T=cKDTree(P)
pairs=T.query_pairs(R,output_type='ndarray')
i,j=pairs[:,0],pairs[:,1]
d=P[j]-P[i]; L2=(d*d).sum(1)+1e-9
# normal divergence estimate: (Nj-Ni).(Pj-Pi)/|d|^2  (+ for convex)
c=((N[j]-N[i])*d).sum(1)/L2
H=np.zeros(len(P)); cnt=np.zeros(len(P))
np.add.at(H,i,c); np.add.at(H,j,c); np.add.at(cnt,i,1); np.add.at(cnt,j,1)
H=H/np.maximum(cnt,1)/2   # mean curvature ~ 1/mm
np.save('curv_H.npy',H)
print(np.percentile(H,[1,5,25,50,75,95,99]).round(3))
cx,cy=111.05,131.37
x=P[:,0]-cx;y=P[:,1]-cy;z=P[:,2]; th=np.arctan2(y,x); r=np.hypot(x,y)
outer=((N[:,0]*x+N[:,1]*y)/(r+1e-9))>0.0
W=2048;Hh=890
ti=((th+np.pi)/(2*np.pi)*W).astype(int)%W; zi=np.clip((z/0.2).astype(int),0,Hh-1)
img=np.zeros((Hh,W,3),np.uint8)
m=outer&(z>4)&np.isfinite(h)&(h>0.4)
v=np.clip(H[m]/0.6,-1,1)
rgb=np.where(v[:,None]<0,np.stack([255*(-v),60*(-v),60*(-v)],1),np.stack([0*v,100*v,255*v],1))+np.array([30,30,30])
img[zi[m],ti[m]]=np.clip(rgb,0,255).astype(np.uint8)
img=np.stack([ndi.maximum_filter(img[...,k],size=3) for k in range(3)],-1)
Image.fromarray(img[::-1]).save('img/curv.png')
