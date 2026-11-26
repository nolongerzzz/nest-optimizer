# NSO steady chuck: a 3-jaw self-centering steady rest that drops over a thin stem mid-print.
import math, numpy as np, manifold3d as m3, trimesh, os, sys
OUT = sys.argv[1] if len(sys.argv) > 1 else 'out'
os.makedirs(OUT, exist_ok=True)
M, CS = m3.Manifold, m3.CrossSection
SEG = 96
C = 0.3                     # sliding clearance
R_OUT = 30                  # head radius
BORE = 9.0                  # head bore radius (stem passes through when the jaws are open)
BASE_H, FLOOR = 6.0, 2.0    # base ring height, floor under the jaw channels
JAW_W, JAW_H, JAW_L = 6.0, 3.6, 16.0
TIP_OPEN, TIP_CLOSED = 9.5, 0.6   # jaw tip radius, open / closed
PIN_OFF, PIN_D = 12.0, 3.4        # pin centre from the tip, pin diameter
CAM_H = 3.0
SWEEP = math.radians(110)         # cam ring turn, open -> closed
SOCK_R, HEX = 24.0, 6.0           # leg sockets: radius, hex across flats
SOCK_D = 5.0

def cyl(r, h, z=0, seg=SEG): return M.cylinder(h, r, r, seg).translate([0, 0, z])
def box(x0, x1, y0, y1, z0, z1): return M.cube([x1 - x0, y1 - y0, z1 - z0]).translate([x0, y0, z0])
def hexprism(af, h, z=0):
    r = af / 2 / math.cos(math.pi / 6)
    pts = [[r * math.cos(math.pi / 3 * i), r * math.sin(math.pi / 3 * i)] for i in range(6)]
    return M.extrude(CS([pts]), h).translate([0, 0, z])
def rot(mf, deg): return mf.rotate([0, 0, deg])

# ---- base ring: three radial channels at 90, 210, 330 deg, leg sockets between them, a rim mark at 90
ANG = [90, 210, 330]
base = cyl(R_OUT, BASE_H) - cyl(BORE, BASE_H + 2, -1)
for a in ANG:
    ch = box(0, R_OUT - 3.8, -(JAW_W + 2 * C) / 2, (JAW_W + 2 * C) / 2, FLOOR, BASE_H + 1)
    base = base - rot(ch, a)
for a in ANG:
    s = hexprism(HEX + 2 * C, SOCK_D + 0.01, -0.01).translate([SOCK_R, 0, 0])
    base = base - rot(s, a + 60)
# grip flats for holding the base while turning the ring
for a in ANG:
    base = base - rot(box(R_OUT - 1.2, R_OUT + 1, -6, 6, -1, BASE_H + 1), a + 60)

# ---- a jaw (built along +x, tip at x=0), lying in its channel; pin on top
def jaw():
    hw = JAW_W / 2
    body = M.extrude(CS([[[0, -0.5], [4, -hw], [JAW_L, -hw], [JAW_L, hw], [4, hw], [0, 0.5]]]), JAW_H)
    pin_h = BASE_H + CAM_H - (FLOOR + JAW_H) - 0.2
    pin = cyl(PIN_D / 2, pin_h, JAW_H - 0.01, 48).translate([PIN_OFF, 0, 0])
    return body + pin

# ---- cam ring: three spiral slots, the pin's radius going from open to closed over SWEEP
def cam_ring():
    ring = cyl(R_OUT, CAM_H) - cyl(BORE, CAM_H + 2, -1)
    r_open, r_closed = TIP_OPEN + PIN_OFF, TIP_CLOSED + PIN_OFF
    w = (PIN_D + 2 * C + 0.2) / 2
    for k in range(3):
        a0 = math.radians(ANG[k])
        hulls = []
        N = 44
        pts = []
        for i in range(N + 1):
            t = i / N
            # turning the ring by +theta (counter-clockwise, seen from above) moves each pin inward: the slot runs back by -theta
            th = a0 - SWEEP * t
            r = r_open + (r_closed - r_open) * t
            pts.append((r * math.cos(th), r * math.sin(th)))
        for i in range(N):
            hulls.append(M.batch_hull([cyl(w, CAM_H + 2, -1, 32).translate([pts[i][0], pts[i][1], 0]),
                                       cyl(w, CAM_H + 2, -1, 32).translate([pts[i + 1][0], pts[i + 1][1], 0])]))
        ring = ring - M.batch_boolean(hulls, m3.OpType.Add)
    # knurl: 36 shallow notches round the edge
    for i in range(36):
        ring = ring - rot(cyl(0.9, CAM_H + 2, -1, 16).translate([R_OUT + 0.3, 0, 0]), i * 10 + 5)
    # a pointer notch on top, and a CLOSE arrow (a wedge) beside it
    ring = ring - box(R_OUT - 5, R_OUT + 1, -0.6, 0.6, CAM_H - 0.6, CAM_H + 1)
    return ring

# ---- a leg: hex post, flat-lying print, its top into the head's socket; a foot disc with a hex socket
def leg(L): return hexprism(HEX, L)
def foot(): return cyl(9, 1.6) + (hexprism(HEX + 4, 4, 1.6) - hexprism(HEX + 2 * C, 6, 1.0))

def save(mf, name):
    mesh = mf.to_mesh()
    tm = trimesh.Trimesh(vertices=np.array(mesh.vert_properties)[:, :3], faces=np.array(mesh.tri_verts))
    tm.export(os.path.join(OUT, name))
    return tm

parts = {}
parts['base'] = base
parts['jaw'] = jaw()
parts['cam'] = cam_ring()
parts['foot'] = foot()
LEGS = [15, 25, 35, 45, 55, 65, 75, 85, 95]
for L in LEGS: parts['leg%d' % L] = leg(L)
for k, v in parts.items():
    assert v.status() == m3.Error.NoError, k
    print(k, 'volume %.0f mm3' % v.volume(), 'genus', v.genus())
save(parts['base'], 'chuck_base.stl'); save(parts['jaw'], 'chuck_jaw_x3.stl'); save(parts['cam'], 'chuck_cam_ring.stl'); save(parts['foot'], 'chuck_foot_x3.stl')
for L in LEGS: save(rot(parts['leg%d' % L].rotate([0, 90, 0]), 0).translate([0, 0, HEX / 2]), 'chuck_leg_%dmm_x3.stl' % L)

# ---- the assembled head (for the pictures and an interference check), at a jaw position t (0 open, 1 closed)
def assembled(t):
    tip = TIP_OPEN + (TIP_CLOSED - TIP_OPEN) * t
    asm = [base]
    for a in ANG: asm.append(rot(parts['jaw'].translate([tip, 0, FLOOR + 0.05]), a))
    asm.append(rot(parts['cam'].translate([0, 0, BASE_H + 0.05]), math.degrees(SWEEP * t)))
    return asm
for t in (0, 0.5, 1):
    a = assembled(t)
    hit = []
    for i in range(len(a)):
        for j in range(i + 1, len(a)):
            v = (a[i] ^ a[j]).volume()
            if v > 0.01: hit.append((i, j, round(v, 2)))
    print('t', t, 'interference', hit)
np.save(os.path.join(OUT, 'dims.npy'), np.array([R_OUT, BASE_H + CAM_H, FLOOR, JAW_H, SOCK_D]))
import pickle
for t in (0, 1):
    m = M.batch_boolean(assembled(t), m3.OpType.Add)
    save(m, 'asm_%d.stl' % t)
