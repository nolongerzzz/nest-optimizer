#!/usr/bin/env python3
"""Photogrammetry-mesh triage: the numbers that decide whether NSO_Repair can
take this mesh. Boundary-loop sizes matter most - NSO_Repair.fillHoles refuses
any loop longer than 64 edges."""
import sys, json, collections
import numpy as np, trimesh

def loops_from_boundary(edges):
    adj=collections.defaultdict(list)
    for a,b in edges:
        adj[a].append(b); adj[b].append(a)
    seen=set(); loops=[]
    for s in list(adj):
        if s in seen: continue
        comp=[]; stack=[s]; seen.add(s)
        while stack:
            v=stack.pop(); comp.append(v)
            for w in adj[v]:
                if w not in seen: seen.add(w); stack.append(w)
        # edges inside this component
        n=sum(len(adj[v]) for v in comp)//2
        loops.append(n)
    return sorted(loops, reverse=True)

def main(path):
    m=trimesh.load(path, process=False)
    if isinstance(m, trimesh.Scene): m=trimesh.util.concatenate(tuple(m.geometry.values()))
    V=len(m.vertices); F=len(m.faces)
    mw=m.copy(); mw.merge_vertices()
    ec=collections.Counter()
    f=mw.faces
    for tri in f:
        for i in range(3):
            a,b=tri[i],tri[(i+1)%3]
            ec[(a,b) if a<b else (b,a)]+=1
    openE=[e for e,c in ec.items() if c==1]
    nm=[e for e,c in ec.items() if c>2]
    loops=loops_from_boundary(openE)
    ext=m.bounding_box.extents
    out={
      'file':path,'vertices_raw':V,'faces':F,
      'vertices_welded':len(mw.vertices),
      'open_edges':len(openE),'non_manifold_edges':len(nm),
      'odd_edges':len(openE)+len(nm),
      'boundary_loops':len(loops),
      'largest_loops':loops[:12],
      'loops_over_64':sum(1 for L in loops if L>64),
      'loops_le_64':sum(1 for L in loops if L<=64),
      'edges_in_loops_over_64':int(sum(L for L in loops if L>64)),
      'components':int(mw.body_count),
      'is_watertight':bool(mw.is_watertight),
      'is_winding_consistent':bool(mw.is_winding_consistent),
      'euler':int(mw.euler_number),
      'bbox_extent':[round(float(x),4) for x in ext],
      'bbox_diagonal':round(float(np.linalg.norm(ext)),4),
      'volume_signed':round(float(mw.volume),4),
      'area':round(float(mw.area),4),
      'degenerate_faces':int((~mw.nondegenerate_faces()).sum()),
      'mean_edge_len':round(float(np.mean(mw.edges_unique_length)),6),
      'min_edge_len':round(float(np.min(mw.edges_unique_length)),8),
    }
    print(json.dumps(out,indent=1))

if __name__=='__main__': main(sys.argv[1])
