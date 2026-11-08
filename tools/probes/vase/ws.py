import numpy as np, sys
from PIL import Image
from scipy import ndimage as ndi
P=np.load('rel3d_P.npy'); h=np.load('rel3d_h.npy'); N=np.load('rel3d_N.npy')
tau=float(sys.argv[1]); HH=float(sys.argv[2])
cx,cy=111.05,131.37
x=P[:,0]-cx;y=P[:,1]-cy;z=P[:,2]; th=np.arctan2(y,x); r=np.hypot(x,y)
outer=((N[:,0]*x+N[:,1]*y)/(r+1e-9))>0.0
res=0.4; W=int(2*np.pi*60/res)  # ~ arc at r=60
W=943; Hh=int(180/res)
ti=((th+np.pi)/(2*np.pi)*W).astype(int)%W; zi=np.clip((z/res).astype(int),0,Hh-1)
m=outer&np.isfinite(h)&(h>tau)&(z>9)&(z<172)
mask=np.zeros((Hh,W),bool); mask[zi[m],ti[m]]=True
mask=ndi.binary_closing(mask,iterations=2); mask=ndi.binary_opening(mask,iterations=1)
# remove tiny
lab,n=ndi.label(mask); sz=ndi.sum(mask,lab,range(1,n+1)); keep=np.isin(lab,1+np.where(sz>40)[0]); mask=keep
dt=ndi.distance_transform_edt(mask)*res
dts=ndi.gaussian_filter(dt,1.0)
# h-maxima markers
def hmax(f,hh):
    from scipy.ndimage import grey_dilation
    # reconstruction by dilation of f-hh under f
    rec=f-hh
    prev=None
    while True:
        nxt=np.minimum(ndi.grey_dilation(rec,size=3),f)
        if np.array_equal(nxt,rec): break
        rec=nxt
    return (f-rec)>=hh-1e-6
mk=hmax(dts,HH)&mask
ml,nm=ndi.label(mk,structure=np.ones((3,3)))
print('markers',nm)
# watershed via skimage if available else simple priority flood
try:
    from skimage.segmentation import watershed
    seg=watershed(-dts,ml,mask=mask)
except Exception as e:
    print('no skimage',e); raise
cnt=np.bincount(seg.ravel())
print('segments',(cnt>0).sum()-1)
rng=np.random.RandomState(3); col=rng.randint(70,255,(nm+2,3)).astype(np.uint8); col[0]=0
img=col[seg]
# draw dt maxima
img[mk]=255
Image.fromarray(img[::-1]).resize((W*2,Hh*2),Image.NEAREST).save('img/ws.png')
np.save('ws_seg.npy',seg)
