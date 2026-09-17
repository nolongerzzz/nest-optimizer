#!/usr/bin/env python3
"""Make defocus-blurred copies of a fixed image subset, to measure how much
softness a capture can carry before SfM degrades."""
import sys, os, json
from PIL import Image, ImageFilter
src=sys.argv[1]; dst_root=sys.argv[2]; names=json.load(open(sys.argv[3]))
for sigma in [0,1,2,4,8]:
    d=f'{dst_root}/blur{sigma}'
    os.makedirs(d,exist_ok=True)
    for n in names:
        im=Image.open(os.path.join(src,n))
        if sigma: im=im.filter(ImageFilter.GaussianBlur(sigma))
        im.save(os.path.join(d,n), quality=95)
    print('wrote',d,len(names),'images')
