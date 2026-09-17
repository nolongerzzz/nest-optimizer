#!/usr/bin/env python3
import sys, numpy as np, trimesh
src,dst=sys.argv[1],sys.argv[2]
m=trimesh.load(src, process=False)
if isinstance(m,trimesh.Scene): m=trimesh.util.concatenate(tuple(m.geometry.values()))
print('loaded',len(m.vertices),'verts',len(m.faces),'faces')
if len(sys.argv)>3:                      # optional uniform scale
    m.apply_scale(float(sys.argv[3]))
m.export(dst)
print('wrote',dst)
