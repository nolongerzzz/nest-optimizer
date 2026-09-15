#!/usr/bin/env python3
"""meshlib - analytic, individually watertight solids for test-part generators.

Stdlib only, to match tools/stl_watertight_check.py and tools/mesh_validate.py
(there is no numpy in the sandbox this runs in, and nothing here needs one).

The pattern this library exists for is the one tools/csg_bench/make_fixtures.py
already uses and tools/breakaway_coupons.py builds on: every primitive is
triangulated analytically from shared vertex rings, so it is closed and
outward-wound by construction, and a "part" is a plain concatenation of such
primitives that overlap volumetrically. There is no boolean engine. A slicer
unions overlapping closed shells per layer, so an overlapped concatenation
prints as one solid while every shell stays independently checkable.

A mesh is a list of triangles; a triangle is a tuple of three (x, y, z) tuples
in millimetres, Z up.

Primitives
    box(x0, x1, y0, y1, z0, z1)
    extrude_polygon(poly, z0, z1)         simple polygon (any winding) -> prism
    tapered_ring(cx, cy, z0, z1, r_out0, r_out1, r_in0, r_in1, segments)
    cylinder(cx, cy, z0, z1, r, segments)

Checks
    verify(tris)          the same edge-parity / degenerate test as
                          tools/stl_watertight_check.py --odd --degen, plus
                          directed-edge winding consistency and signed volume
    signed_volume(tris), surface_area(tris), bbox(tris)

I/O
    write_binary_stl(path, tris)
"""
from __future__ import annotations

import math
import struct
from collections import defaultdict
from typing import Dict, Iterable, List, Sequence, Tuple

Point = Tuple[float, float, float]
Tri = Tuple[Point, Point, Point]

# Edge keys are quantised to 5 dp, exactly like tools/stl_watertight_check.py,
# so a mesh that passes verify() here passes that checker on its STL.
EDGE_QUANT_DP = 5
# Zero-area threshold, mm^2. Same constant as stl_watertight_check.py.
DEGEN_AREA = 1e-12


# ---------------------------------------------------------------- vector bits

def _sub(a: Point, b: Point) -> Point:
    return (a[0] - b[0], a[1] - b[1], a[2] - b[2])


def _cross(a: Point, b: Point) -> Point:
    return (a[1] * b[2] - a[2] * b[1],
            a[2] * b[0] - a[0] * b[2],
            a[0] * b[1] - a[1] * b[0])


def _dot(a: Point, b: Point) -> float:
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def tri_area(a: Point, b: Point, c: Point) -> float:
    n = _cross(_sub(b, a), _sub(c, a))
    return 0.5 * math.sqrt(_dot(n, n))


def tri_normal(a: Point, b: Point, c: Point) -> Point:
    n = _cross(_sub(b, a), _sub(c, a))
    L = math.sqrt(_dot(n, n)) or 1.0
    return (n[0] / L, n[1] / L, n[2] / L)


# ---------------------------------------------------------------- transforms

def translate(tris: Iterable[Tri], dx: float, dy: float, dz: float) -> List[Tri]:
    return [tuple((p[0] + dx, p[1] + dy, p[2] + dz) for p in t) for t in tris]  # type: ignore[misc]


def concat(*meshes: Iterable[Tri]) -> List[Tri]:
    out: List[Tri] = []
    for m in meshes:
        out.extend(m)
    return out


# ---------------------------------------------------------------- primitives

def _quad(a: Point, b: Point, c: Point, d: Point) -> List[Tri]:
    """Two triangles for the quad a-b-c-d (given in one consistent winding)."""
    return [(a, b, c), (a, c, d)]


def box(x0: float, x1: float, y0: float, y1: float, z0: float, z1: float) -> List[Tri]:
    """Axis-aligned closed box, outward-wound. 12 triangles."""
    if not (x1 > x0 and y1 > y0 and z1 > z0):
        raise ValueError("box needs x1>x0, y1>y0, z1>z0")
    p = [(x0, y0, z0), (x1, y0, z0), (x1, y1, z0), (x0, y1, z0),
         (x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1)]
    tris: List[Tri] = []
    tris += _quad(p[0], p[3], p[2], p[1])   # bottom  (-z)
    tris += _quad(p[4], p[5], p[6], p[7])   # top     (+z)
    tris += _quad(p[0], p[1], p[5], p[4])   # front   (-y)
    tris += _quad(p[2], p[3], p[7], p[6])   # back    (+y)
    tris += _quad(p[3], p[0], p[4], p[7])   # left    (-x)
    tris += _quad(p[1], p[2], p[6], p[5])   # right   (+x)
    return tris


def polygon_area(poly: Sequence[Tuple[float, float]]) -> float:
    """Signed shoelace area; positive for counter-clockwise."""
    s = 0.0
    n = len(poly)
    for i in range(n):
        x0, y0 = poly[i]
        x1, y1 = poly[(i + 1) % n]
        s += x0 * y1 - x1 * y0
    return 0.5 * s


def _cross2(o, a, b) -> float:
    return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])


def _point_in_tri(p, a, b, c, inclusive: bool, eps: float) -> bool:
    d0, d1, d2 = _cross2(a, b, p), _cross2(b, c, p), _cross2(c, a, p)
    if inclusive:
        return d0 >= -eps and d1 >= -eps and d2 >= -eps
    return d0 > eps and d1 > eps and d2 > eps


def ear_clip(poly: Sequence[Tuple[float, float]], eps: float = 1e-9) -> List[Tuple[int, int, int]]:
    """Triangulate a simple polygon by ear clipping. Returns index triples,
    counter-clockwise regardless of the input winding.

    Reflex vertices are handled (the polygons this is used for are notched
    rectangles), collinear vertices are dropped rather than emitted as zero-area
    ears, and the result is checked: the triangle areas must sum to the polygon
    area, or a ValueError is raised instead of returning a broken cap.
    """
    n = len(poly)
    if n < 3:
        raise ValueError("polygon needs at least 3 vertices")
    area = polygon_area(poly)
    if abs(area) < eps:
        raise ValueError("polygon has zero area")
    idx = list(range(n))
    if area < 0:
        idx.reverse()
    tris: List[Tuple[int, int, int]] = []

    def try_clip(inclusive: bool) -> bool:
        m = len(idx)
        for i in range(m):
            a, b, c = idx[i - 1], idx[i], idx[(i + 1) % m]
            pa, pb, pc = poly[a], poly[b], poly[c]
            cr = _cross2(pa, pb, pc)
            if cr <= eps:
                continue                       # reflex or collinear: not an ear
            ok = True
            for j in idx:
                if j in (a, b, c):
                    continue
                if _point_in_tri(poly[j], pa, pb, pc, inclusive, eps):
                    ok = False
                    break
            if ok:
                tris.append((a, b, c))
                del idx[i]
                return True
        return False

    def drop_collinear() -> bool:
        m = len(idx)
        for i in range(m):
            a, b, c = idx[i - 1], idx[i], idx[(i + 1) % m]
            if abs(_cross2(poly[a], poly[b], poly[c])) <= eps:
                del idx[i]
                return True
        return False

    while len(idx) > 3:
        if try_clip(True) or try_clip(False) or drop_collinear():
            continue
        raise ValueError("ear clipping stuck: polygon is not simple")
    a, b, c = idx
    if _cross2(poly[a], poly[b], poly[c]) > eps:
        tris.append((a, b, c))

    got = sum(abs(_cross2(poly[a], poly[b], poly[c])) * 0.5 for a, b, c in tris)
    if abs(got - abs(area)) > 1e-6 * max(1.0, abs(area)):
        raise ValueError("ear clipping produced the wrong area: %.6f vs %.6f" % (got, abs(area)))
    return tris


def extrude_polygon(poly: Sequence[Tuple[float, float]], z0: float, z1: float) -> List[Tri]:
    """Closed prism from a simple 2D polygon (any winding), z0 -> z1, outward-wound."""
    if z1 <= z0:
        raise ValueError("extrude_polygon needs z1 > z0")
    pts = list(poly)
    if polygon_area(pts) < 0:
        pts.reverse()
    caps = ear_clip(pts)
    n = len(pts)
    bot = [(x, y, z0) for x, y in pts]
    top = [(x, y, z1) for x, y in pts]
    tris: List[Tri] = []
    for a, b, c in caps:
        tris.append((bot[a], bot[c], bot[b]))   # bottom faces -z: reverse the CCW cap
        tris.append((top[a], top[b], top[c]))   # top faces +z
    for i in range(n):
        j = (i + 1) % n
        # CCW outline walked at z0 then z1: (i, j, j', i') is outward for a CCW polygon
        tris += _quad(bot[i], bot[j], top[j], top[i])
    return tris


def tapered_ring(cx: float, cy: float, z0: float, z1: float,
                 r_out0: float, r_out1: float, r_in0: float, r_in1: float,
                 segments: int = 96) -> List[Tri]:
    """Closed annular solid whose outer and inner radii each vary linearly from
    z0 (r_*0) to z1 (r_*1). A ring tip is r_out1 - r_in1 < r_out0 - r_in0.
    Outward-wound; the inner wall faces the hole."""
    if z1 <= z0:
        raise ValueError("tapered_ring needs z1 > z0")
    for ro, ri in ((r_out0, r_in0), (r_out1, r_in1)):
        if not (ro > ri > 0.0):
            raise ValueError("tapered_ring needs r_out > r_in > 0 at both ends")

    def ring(r: float, z: float) -> List[Point]:
        return [(cx + r * math.cos(2 * math.pi * i / segments),
                 cy + r * math.sin(2 * math.pi * i / segments), z)
                for i in range(segments)]

    ob, ot = ring(r_out0, z0), ring(r_out1, z1)
    ib, it = ring(r_in0, z0), ring(r_in1, z1)
    tris: List[Tri] = []
    for i in range(segments):
        j = (i + 1) % segments
        tris += _quad(ob[i], ob[j], ot[j], ot[i])   # outer wall, faces out
        tris += _quad(ib[j], ib[i], it[i], it[j])   # inner wall, faces the hole
        tris += _quad(ot[i], ot[j], it[j], it[i])   # top annulus, +z
        tris += _quad(ob[j], ob[i], ib[i], ib[j])   # bottom annulus, -z
    return tris


def cylinder(cx: float, cy: float, z0: float, z1: float, r: float, segments: int = 64) -> List[Tri]:
    """Closed cylinder with fan caps (no zero-area triangles)."""
    if z1 <= z0 or r <= 0:
        raise ValueError("cylinder needs z1 > z0 and r > 0")
    rb = [(cx + r * math.cos(2 * math.pi * i / segments),
           cy + r * math.sin(2 * math.pi * i / segments), z0) for i in range(segments)]
    rt = [(x, y, z1) for x, y, _ in rb]
    cb, ct = (cx, cy, z0), (cx, cy, z1)
    tris: List[Tri] = []
    for i in range(segments):
        j = (i + 1) % segments
        tris += _quad(rb[i], rb[j], rt[j], rt[i])
        tris.append((ct, rt[i], rt[j]))
        tris.append((cb, rb[j], rb[i]))
    return tris


# ---------------------------------------------------------------- measurement

def signed_volume(tris: Iterable[Tri]) -> float:
    v = 0.0
    for a, b, c in tris:
        v += _dot(a, _cross(b, c))
    return v / 6.0


def surface_area(tris: Iterable[Tri]) -> float:
    return sum(tri_area(*t) for t in tris)


def bbox(tris: Iterable[Tri]) -> Tuple[Point, Point]:
    lo = [math.inf] * 3
    hi = [-math.inf] * 3
    for t in tris:
        for p in t:
            for k in range(3):
                if p[k] < lo[k]:
                    lo[k] = p[k]
                if p[k] > hi[k]:
                    hi[k] = p[k]
    return (lo[0], lo[1], lo[2]), (hi[0], hi[1], hi[2])


# ---------------------------------------------------------------- verify

def _q(p: Point) -> Point:
    return (round(p[0], EDGE_QUANT_DP), round(p[1], EDGE_QUANT_DP), round(p[2], EDGE_QUANT_DP))


def verify(tris: Sequence[Tri]) -> Dict[str, object]:
    """Watertight / degenerate check with the semantics of
    tools/stl_watertight_check.py --odd --degen, plus two things that checker
    cannot see: directed-edge winding consistency and the sign of the volume.

    Returns a dict; 'ok' is True only when every count is zero and the volume
    is positive. Note what this does NOT test: two closed shells that overlap
    (the deliberate volumetric-overlap construction) pass, because every edge
    still has exactly two faces. That is by design -- see the module docstring.
    """
    undirected: Dict[Tuple[Point, Point], int] = defaultdict(int)
    directed: Dict[Tuple[Point, Point], int] = defaultdict(int)
    degenerate = 0
    for a, b, c in tris:
        if tri_area(a, b, c) < DEGEN_AREA:
            degenerate += 1
        qa, qb, qc = _q(a), _q(b), _q(c)
        for u, v in ((qa, qb), (qb, qc), (qc, qa)):
            undirected[(u, v) if u <= v else (v, u)] += 1
            directed[(u, v)] += 1
    open_edges = sum(1 for n in undirected.values() if n == 1)
    nonmanifold = sum(1 for n in undirected.values() if n > 2)
    odd = sum(1 for n in undirected.values() if n != 2)
    # A directed edge used twice means two faces meet with the same winding,
    # i.e. one of them is inside out.
    winding_bad = sum(1 for n in directed.values() if n > 1)
    vol = signed_volume(tris)
    ok = (odd == 0 and degenerate == 0 and winding_bad == 0 and vol > 0 and len(tris) >= 4)
    return {
        "ok": ok,
        "tris": len(tris),
        "unique_edges": len(undirected),
        "open_edges": open_edges,
        "nonmanifold_edges": nonmanifold,
        "odd_edges": odd,
        "degenerate_tris": degenerate,
        "winding_inconsistent": winding_bad,
        "signed_volume": vol,
    }


def describe_failure(report: Dict[str, object]) -> str:
    bits = []
    if report["odd_edges"]:
        bits.append("odd edges %d (open %d, non-manifold %d)" % (
            report["odd_edges"], report["open_edges"], report["nonmanifold_edges"]))
    if report["degenerate_tris"]:
        bits.append("degenerate tris %d" % report["degenerate_tris"])
    if report["winding_inconsistent"]:
        bits.append("inconsistent winding on %d edges" % report["winding_inconsistent"])
    if report["signed_volume"] <= 0:
        bits.append("signed volume %.6f (not positive)" % report["signed_volume"])
    if int(report["tris"]) < 4:
        bits.append("only %d triangles" % report["tris"])
    return "; ".join(bits) or "ok"


# ---------------------------------------------------------------- STL out

def write_binary_stl(path, tris: Sequence[Tri], header: bytes = b"nso meshlib") -> int:
    """Binary STL, normals recomputed from winding. Same layout as
    tools/csg_bench/make_fixtures.py::write_stl."""
    with open(path, "wb") as f:
        f.write(header.ljust(80, b"\0"))
        f.write(struct.pack("<I", len(tris)))
        for a, b, c in tris:
            nx, ny, nz = tri_normal(a, b, c)
            f.write(struct.pack("<12fH", nx, ny, nz, *a, *b, *c, 0))
    return len(tris)
