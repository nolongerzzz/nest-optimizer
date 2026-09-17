#!/usr/bin/env python3
"""Decimate the scan mesh to a series of triangle budgets - both to build the
cost curve and because a triangle budget is what any real pre-stage would
impose before handing the mesh on."""
import sys, numpy as np, trimesh, fast_simplification
src=sys.argv[1]; out=sys.argv[2]
m=trimesh.load(src, process=False); m.merge_vertices()
V=np.asarray(m.vertices,dtype=np.float32); F=np.asarray(m.faces,dtype=np.int32)
for target in [int(x) for x in sys.argv[3:]]:
    ratio=1.0-target/len(F)
    if ratio<=0: continue
    v,f=fast_simplification.simplify(V,F,ratio)
    g=trimesh.Trimesh(vertices=v,faces=f,process=False)
    p=f"{out}/dec_{target//1000}k.stl"
    g.export(p)
    print(f"{target//1000}k -> {len(f):,} faces  {p}")
