import numpy as np
from PIL import Image
from scipy import ndimage as ndi
P=np.load('rel3d_P.npy'); h=np.load('rel3d_h.npy'); N=np.load('rel3d_N.npy')
cx,cy=111.05,131.37
x=P[:,0]-cx;y=P[:,1]-cy;z=P[:,2]; th=np.arctan2(y,x); r=np.hypot(x,y)
outer=((N[:,0]*x+N[:,1]*y)/(r+1e-9))>0.0
W=2048;H=890
ti=((th+np.pi)/(2*np.pi)*W).astype(int)%W; zi=np.clip((z/0.2).astype(int),0,H-1)
pal=np.array([[0,0,0],[40,40,120],[40,120,200],[40,200,120],[220,220,40],[240,120,30],[240,40,40],[255,255,255]],np.uint8)
edges=[0.4,1,1.8,2.8,4,6,10]
b=np.digitize(np.nan_to_num(h,nan=0),edges)
img=np.zeros((H,W),np.uint8)
m=outer&(z>4)
# paint higher bands last
o=np.argsort(b[m]); ii=np.where(m)[0][o]
img[zi[ii],ti[ii]]=b[ii]
img=ndi.maximum_filter(img,size=3)
Image.fromarray(pal[img][::-1]).save('img/bands.png')
