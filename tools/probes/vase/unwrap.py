import numpy as np
from PIL import Image
s=np.fromfile('vase.f32',dtype=np.float32).reshape(-1,3,3)
c=s.mean(1)
bot=s.reshape(-1,3); bot=bot[bot[:,2]<0.4]; cx,cy=bot[:,0].mean(),bot[:,1].mean()
print(cx,cy)
x=c[:,0]-cx;y=c[:,1]-cy;z=c[:,2]
r=np.hypot(x,y);th=np.arctan2(y,x)
n=np.cross(s[:,1]-s[:,0],s[:,2]-s[:,0]);n/=np.linalg.norm(n,axis=1,keepdims=True)+1e-12
outer=(n[:,0]*x+n[:,1]*y)/(r+1e-9)>0.15
W=2048;H=int(178/0.1)  # 0.1mm z rows too much; use 0.2
H=890
ti=((th+np.pi)/(2*np.pi)*W).astype(int)%W; zi=np.clip((z/0.2).astype(int),0,H-1)
img=np.full((H,W),np.nan,np.float32)
idx=outer
# max radius per cell
flat=zi[idx]*W+ti[idx]; rv=r[idx]
order=np.argsort(rv); 
tmp=np.full(H*W,np.nan,np.float32); tmp[flat[order]]=rv[order]
img=tmp.reshape(H,W)
np.save('unwrap_r.npy',img)
# profile: nanmedian lowpercentile per row
prof=np.array([np.nanpercentile(row,15) if np.isfinite(row).sum()>20 else np.nan for row in img])
rel=img-prof[:,None]
np.save('unwrap_rel.npy',rel)
v=np.clip((rel+0.5)/6,0,1); v[~np.isfinite(v)]=0
Image.fromarray((v[::-1]*255).astype(np.uint8)).save('img/unwrap_rel.png')
print(np.nanmax(rel), np.nanpercentile(rel,[5,50,95]))
