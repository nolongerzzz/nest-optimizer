# A small flat-overhang shelf for a first CR-TPU support test: a 10 x 20 column, a 3 mm shelf reaching 14 mm out at 10 mm up, its gap on top
import sys, numpy as np, manifold3d as m3, trimesh
from matplotlib.textpath import TextPath
from matplotlib.font_manager import FontProperties
M, CS = m3.Manifold, m3.CrossSection
def box(x0,x1,y0,y1,z0,z1): return M.cube([x1-x0,y1-y0,z1-z0]).translate([x0,y0,z0])
def label(txt, size, x, y, z, depth):
    tp = TextPath((0,0), txt, size=size, prop=FontProperties(family='DejaVu Sans', weight='bold'))
    polys = [np.array(p) for p in tp.to_polygons() if len(p) > 2]
    cs = CS(polys, m3.FillRule.EvenOdd)
    b = cs.bounds()  # (xmin, ymin, xmax, ymax)
    cs = cs.translate([x - (b[0]+b[2])/2, y - (b[1]+b[3])/2])
    return M.extrude(cs, depth).translate([0,0,z])
def shelf(gap_txt):
    COLX, W, H, T, REACH = 10, 20, 10, 3, 14
    body = box(0, COLX, 0, W, 0, H + T) + box(COLX, COLX + REACH, 0, W, H, H + T)
    return body - label(gap_txt, 6.5, (COLX + REACH) / 2, W / 2, H + T - 0.6, 1)
out = sys.argv[1]
for g in sys.argv[2:]:
    m = shelf(g); mesh = m.to_mesh()
    trimesh.Trimesh(np.array(mesh.vert_properties)[:, :3], np.array(mesh.tri_verts)).export(f'{out}/shelf_{g}.stl')
    print(g, round(m.volume()), m.genus())
