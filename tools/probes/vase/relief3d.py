import numpy as np, time
from scipy.spatial import cKDTree
from PIL import Image
t0=time.time()
s=np.fromfile('vase.f32',dtype=np.float32).reshape(-1,3,3)
# area-weighted sample: triangle centroids of every 4th triangle
c=s.mean(1); n=np.cross(s[:,1]-s[:,0],s[:,2]-s[:,0]); a=np.linalg.norm(n,axis=1)/2; n/= (2*a[:,None]+1e-12)
sel=np.arange(0,len(c),3); P=c[sel].astype(np.float64); N=n[sel].astype(np.float64)
print('samples',len(P))
tree=cKDTree(P)
# seeds: one per 5mm voxel
vi=np.floor(P/5).astype(int); _,first=np.unique(vi,axis=0,return_index=True); S=first; print('seeds',len(S))
W=22.0
relief=np.full(len(P),np.nan); best=np.full(len(P),1e9)
for k,si in enumerate(S):
    idx=tree.query_ball_point(P[si],W)
    if len(idx)<60: continue
    idx=np.array(idx); idx=idx[N[idx]@N[si]>0.3]
    if len(idx)<60: continue
    Q=P[idx]; nb=N[idx]
    # frame from the mean normal of the lowest points: start with the PCA normal
    ctr=P[si]; d=Q-ctr
    w,v=np.linalg.eigh(d.T@d); nz=v[:,0]
    if nz@N[si]<0: nz=-nz
    u=np.cross(nz,[1,0,0]); 
    if np.linalg.norm(u)<1e-3: u=np.cross(nz,[0,1,0])
    u/=np.linalg.norm(u); vv=np.cross(nz,u)
    X=d@u; Y=d@vv; Z=d@nz
    A=np.stack([np.ones_like(X),X,Y,X*X,X*Y,Y*Y],1)
    keep=np.ones(len(Z),bool)
    # init: points under the 35th percentile of residual from a plane fit
    co=np.linalg.lstsq(A[:,:3],Z,rcond=None)[0]; r=Z-A[:,:3]@co; keep=r<np.percentile(r,35)
    for it in range(6):
        if keep.sum()<20: break
        co=np.linalg.lstsq(A[keep],Z[keep],rcond=None)[0]; r=Z-A@co
        keep=r<0.25
    r=Z-A@co
    # relief for the points near the seed (within 3.5 mm): take the fit of the nearest seed
    dist=np.hypot(X,Y)
    near=idx[dist<4.0]; dd=dist[dist<4.0]
    rr=r[dist<4.0]
    upd=dd<best[near]; relief[near[upd]]=rr[upd]; best[near[upd]]=dd[upd]
print('done',time.time()-t0,'s; nan',np.isnan(relief).sum())
np.save('rel3d_P.npy',P); np.save('rel3d_N.npy',N); np.save('rel3d_h.npy',relief)
print(np.nanpercentile(relief,[1,25,50,75,90,95,99]))
