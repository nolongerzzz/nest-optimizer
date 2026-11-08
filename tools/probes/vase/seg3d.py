import numpy as np, sys
from scipy.spatial import cKDTree
from scipy import sparse
from scipy.sparse.csgraph import connected_components
from PIL import Image
P=np.load('rel3d_P.npy'); h=np.load('rel3d_h.npy'); N=np.load('rel3d_N.npy')
tau=float(sys.argv[1]) if len(sys.argv)>1 else 0.5
ok=np.isfinite(h)&(h>tau)
# drop rim/base noise: near z extremes
ok&=(P[:,2]>3)&(P[:,2]<P[:,2].max()-0)  
idx=np.where(ok)[0]; T=cKDTree(P[idx]); pairs=T.query_pairs(1.2,output_type='ndarray')
g=sparse.coo_matrix((np.ones(len(pairs)),(pairs[:,0],pairs[:,1])),shape=(len(idx),len(idx)))
nc,lab=connected_components(g,directed=False)
cnt=np.bincount(lab); order=np.argsort(-cnt)
print('tau',tau,'components',nc)
for k in order[:20]:
    m=lab==k; p=P[idx][m]
    print(k,cnt[k],'bbox',p.min(0).round(0),p.max(0).round(0),'h med/p95/max',np.median(h[idx][m]).round(1),np.percentile(h[idx][m],95).round(1),h[idx][m].max().round(1))
np.save('seg_idx.npy',idx); np.save('seg_lab.npy',lab)
# image coloured by component
cx,cy=111.05,131.37
rng=np.random.RandomState(1); col=rng.randint(60,255,(nc,3)); 
x=P[idx,0]-cx;y=P[idx,1]-cy;z=P[idx,2]; th=np.arctan2(y,x); r=np.hypot(x,y)
outer=((N[idx,0]*x+N[idx,1]*y)/(r+1e-9))>0.0
W=2048;H=890
ti=((th+np.pi)/(2*np.pi)*W).astype(int)%W; zi=np.clip((z/0.2).astype(int),0,H-1)
img=np.zeros((H,W,3),np.uint8)
big=np.isin(lab,order[:12])
m=outer
img[zi[m],ti[m]]=np.where(big[m,None],col[lab[m]],90)
from scipy import ndimage as ndi
img=np.stack([ndi.maximum_filter(img[...,i],size=3) for i in range(3)],-1)
Image.fromarray(img[::-1]).save('img/seg.png')
