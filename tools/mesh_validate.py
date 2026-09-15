#!/usr/bin/env python3
"""Full validation battery for a triangle mesh (ASCII or binary STL).

Reports real numbers, not pass/fail booleans:
  triangles, unique welded vertices
  open / non-manifold / odd edge counts   (watertight evidence)
  signed volume (mm^3) and surface area   (orientation + solidity evidence)
  degenerate + sliver triangle counts     (seam-sliver evidence)
  inconsistent winding count              (boolean-boundary winding evidence)
  self-intersecting triangle pairs        (split coplanar vs piercing)

Usage:
  python3 tools/mesh_validate.py mesh.stl [--weld 1e-4] [--sliver-aspect 100]
                                          [--no-selfint] [--selfint-raw] [--json]

Self-intersection uses the Moller triangle/triangle overlap test over a uniform
spatial hash. Pairs sharing at least one welded vertex are skipped: adjacent
triangles touch by construction, so counting them would report every mesh as
self-intersecting. Coplanar overlaps are counted separately from true piercing
because a boolean seam legitimately produces coplanar contact, while a piercing
pair never is legitimate.

Stdlib only, to match tools/stl_watertight_check.py.

=========================================================================
CANONICAL self-intersection checker (consolidation, 2026-09-15)
=========================================================================
Three independent implementations existed. This file is the canonical one;
NSO_Repair.js carries a transcription of the same policy for the browser, and
tools/nso_selfint_equiv_test.js asserts the two agree pair-for-pair on every
fixture so they cannot drift again. The third copy, in tools/nso_fuse_testlib.js,
has been deleted.

Four policy axes separated the three. Each was settled by measurement, not by
which branch wrote its version first:

1. GEOMETRY UNDER TEST -- welded, not raw.
   The dominant axis, and the one nobody had written down. NSO_Repair scored
   the welded mesh; this file and the JS copy scored the raw soup. On the tape
   fixture at weld 1e-4 that is 187 piercing pairs against 3,073 -- a 16x
   spread, larger than the other three axes combined. Scoring the raw soup
   while using the weld for adjacency is incoherent, and it re-reports every
   hairline gap the weld just closed. Welded wins. --selfint-raw keeps the old
   behaviour for comparison.

2. ADJACENCY WELD -- radius weld at 1e-4, not a grid snap at 1e-5.
   Two changes. (a) 1e-5 is tolerance-poisoned on real parts: the tape reads
   1,406 open edges and Euler -297 at 1e-5, and 0 open edges and Euler 2 at
   1e-4. NSO_weldEpsFor in app-join.js suffers the same tolerance poisoning
   from the same cause, addressed there by a separate change; the plateau
   measured here for this checker -- 2e-5 .. 3e-4 -- brackets 1e-4. fixtures/repair/
   synth_near_dup_vertex.stl is the clean demonstration: at any tol <= 2e-5 it
   reports 3 piercing pairs and Euler -3, at any tol >= 5e-5 it reports 0 and
   Euler 2, and it is a closed box. The 3 were false. (b) a bare grid snap is
   not a correct "within tol" test at any tol -- two vertices either side of a
   cell boundary never merge however close they are. See weld().

3. ENDPOINT TOUCH -- epsilon-tolerant, not strict.
   Two triangles whose Moller intervals meet at exactly one endpoint touch
   without penetrating. No existing fixture separates the two policies: they
   agree on all 13 across eps 1e-12 .. 1e-5, and differ only on the tape, by
   180 pairs in 3,254. The case that does separate them had to be built (see
   tools/nso_selfint_equiv_test.js, "endpoint" cases), and it decides it:
   strict calls a zero-overlap contact a pierce, and calls an overlap of 1e-12
   a pierce too. STL coordinates are float32, whose ULP is 9.5e-7 at 8 mm and
   1.2e-4 at 1500 mm, so an overlap that small is not geometry -- it is below
   what the file can represent. Strict is reporting its own rounding.

4. COPLANAR OVERLAP -- classified and reported, but kept out of the gate total.
   NSO_Repair deliberately dropped coplanar (docs/NSO_Repair.md "Coplanar
   overlap is not counted"), because counting it needs real 2D polygon overlap
   and a cheap test false-positives on ordinary adjacent geometry. This file
   has the real test -- separating-axis in the plane, strict separation, so
   edge-sharing and point-touching correctly do not overlap -- which retires
   that objection. Coplanar is therefore measured and reported. It stays a
   SEPARATE number rather than being folded into the piercing count, because
   NSO_Repair's repair gate is tuned against piercing and a boolean seam
   produces legitimate coplanar contact.

Broad phase is NOT one of the axes. A uniform hash and a BVH are both
conservative supersets feeding the same exact narrow-phase test, so the choice
is performance only and cannot change a count. It was verified rather than
assumed: NSO_Repair's BVH self-traversal was checked against brute force on
6,000 tape triangles and missed 0 of 39,816 box-overlapping pairs. Each keeps
the structure that suits it -- a hash here, the BVH there.
"""
from __future__ import annotations

import argparse
import json
import math
import struct
import sys
from collections import defaultdict
from pathlib import Path


# ------------------------------------------------------- canonical tolerances

# Vertex weld radius, mm. Matches NSO_Repair.WELD_TOL. See axis 2 above.
WELD_TOL = 1e-4

# Plane-distance / interval-overlap epsilon, mm. Below this a triangle vertex
# counts as lying in the other triangle's plane, and an interval overlap counts
# as contact rather than penetration. See axis 3 above.
SELFINT_EPS = 1e-9


# ---------------------------------------------------------------- STL parsing

def parse_stl(path: Path):
    data = path.read_bytes()
    if data[:5].lower() == b"solid" and b"facet" in data[:300].lower():
        return parse_ascii(data.decode("utf-8", errors="replace"))
    return parse_binary(data)


def parse_ascii(text: str):
    tris, verts = [], []
    for line in text.splitlines():
        parts = line.strip().split()
        if len(parts) >= 4 and parts[0] == "vertex":
            verts.append(tuple(float(x) for x in parts[1:4]))
            if len(verts) == 3:
                tris.append(tuple(verts))
                verts = []
    return tris


def parse_binary(data: bytes):
    if len(data) < 84:
        return []
    n = struct.unpack_from("<I", data, 80)[0]
    tris, off = [], 84
    for _ in range(n):
        if off + 50 > len(data):
            break
        v = struct.unpack_from("<12f", data, off)
        tris.append((v[3:6], v[6:9], v[9:12]))
        off += 50
    return tris


# ------------------------------------------------------------ vector helpers

def sub(a, b):
    return (a[0] - b[0], a[1] - b[1], a[2] - b[2])


def cross(a, b):
    return (a[1] * b[2] - a[2] * b[1],
            a[2] * b[0] - a[0] * b[2],
            a[0] * b[1] - a[1] * b[0])


def dot(a, b):
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def norm(a):
    return math.sqrt(dot(a, a))


# ------------------------------------------------------------------- measures

def tri_area(a, b, c):
    return norm(cross(sub(b, a), sub(c, a))) * 0.5


def signed_volume(tris):
    """Divergence-theorem volume. Positive for outward-facing CCW winding."""
    total = 0.0
    for a, b, c in tris:
        total += dot(a, cross(b, c))
    return total / 6.0


def aspect_ratio(a, b, c):
    """longest edge / (2 * inradius). Equilateral = 1. Sliver -> large."""
    ea, eb, ec = norm(sub(b, a)), norm(sub(c, b)), norm(sub(a, c))
    s = (ea + eb + ec) * 0.5
    area = tri_area(a, b, c)
    if area <= 0.0 or s <= 0.0:
        return float("inf")
    inradius = area / s
    if inradius <= 0.0:
        return float("inf")
    return max(ea, eb, ec) / (2.0 * inradius)


# ------------------------------------------------------------------ topology

def weld(tris, tol):
    """Map float coords -> integer vertex ids, merging anything within `tol`.

    Hash into tol-sized cells, then search the 27-cell neighbourhood and accept
    the first vertex within a true radius `tol`. The neighbourhood search is the
    point: a bare grid snap puts two vertices that straddle a cell boundary into
    different cells no matter how close they are, so it under-welds by an amount
    that depends on where the geometry happens to sit relative to the origin. On
    the tape fixture at tol 1e-5 a bare snap leaves 16,837 vertices and 1,406
    open edges where the radius weld leaves 16,585 and 570 -- 252 vertex pairs
    inside tolerance that the snap refused to merge. Radius weld matches
    NSO_Repair.weldToIndexed, which is what lets the two agree.
    """
    inv = 1.0 / tol
    tol2 = tol * tol
    cells, verts, index = defaultdict(list), [], []
    for tri in tris:
        row = []
        for p in tri:
            ci = (math.floor(p[0] * inv), math.floor(p[1] * inv), math.floor(p[2] * inv))
            vid = -1
            for di in (-1, 0, 1):
                if vid >= 0:
                    break
                for dj in (-1, 0, 1):
                    if vid >= 0:
                        break
                    for dk in (-1, 0, 1):
                        if vid >= 0:
                            break
                        for cand in cells.get((ci[0] + di, ci[1] + dj, ci[2] + dk), ()):
                            q = verts[cand]
                            d2 = ((p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 +
                                  (p[2] - q[2]) ** 2)
                            if d2 <= tol2:
                                vid = cand
                                break
            if vid < 0:
                vid = len(verts)
                verts.append(p)
                cells[ci].append(vid)
            row.append(vid)
        index.append(tuple(row))
    return verts, index


def edge_report(index):
    """Undirected edge multiplicity, plus directed-edge winding consistency."""
    undirected = defaultdict(int)
    directed = defaultdict(int)
    for i, j, k in index:
        for u, v in ((i, j), (j, k), (k, i)):
            undirected[(u, v) if u < v else (v, u)] += 1
            directed[(u, v)] += 1

    open_e = sum(1 for n in undirected.values() if n == 1)
    nonman = sum(1 for n in undirected.values() if n > 2)
    odd = sum(1 for n in undirected.values() if n != 2)

    # A consistently wound closed surface traverses each edge once per
    # direction. Two triangles walking (u,v) the same way are flipped
    # relative to each other.
    bad_winding = sum(1 for e, n in directed.items() if n > 1)

    return {
        "unique_edges": len(undirected),
        "open_edges": open_e,
        "nonmanifold_edges": nonman,
        "odd_edges": odd,
        "inconsistent_winding_edges": bad_winding,
    }


# --------------------------------------------------- Moller tri/tri intersect

def _intervals(vp0, vp1, vp2, d0, d1, d2, d0d1, d0d2):
    """Project the segment where a triangle crosses the other's plane."""
    if d0d1 > 0.0:          # d0, d1 same side -> d2 is the lone vertex
        return _isect(vp2, vp0, vp1, d2, d0, d1)
    if d0d2 > 0.0:
        return _isect(vp1, vp0, vp2, d1, d0, d2)
    if d1 * d2 > 0.0 or d0 != 0.0:
        return _isect(vp0, vp1, vp2, d0, d1, d2)
    if d1 != 0.0:
        return _isect(vp1, vp0, vp2, d1, d0, d2)
    if d2 != 0.0:
        return _isect(vp2, vp0, vp1, d2, d0, d1)
    return None             # coplanar


def _isect(vp_lone, vp_a, vp_b, d_lone, d_a, d_b):
    t0 = vp_lone + (vp_a - vp_lone) * d_lone / (d_lone - d_a)
    t1 = vp_lone + (vp_b - vp_lone) * d_lone / (d_lone - d_b)
    return (t0, t1) if t0 <= t1 else (t1, t0)


def _coplanar_overlap(T1, T2, N, eps):
    """Do two coplanar triangles overlap with positive area?

    Dropped to 2D on the plane's dominant axis, then separating-axis over all
    six edge normals. Triangles that merely share an edge or touch at a point
    have a separating axis and are correctly reported as NOT overlapping --
    which is what makes the coplanar count mean something at a boolean seam.
    """
    drop = max(range(3), key=lambda i: abs(N[i]))
    ax, ay = (drop + 1) % 3, (drop + 2) % 3
    A = [(p[ax], p[ay]) for p in T1]
    B = [(p[ax], p[ay]) for p in T2]

    for poly in (A, B):
        for i in range(3):
            x0, y0 = poly[i]
            x1, y1 = poly[(i + 1) % 3]
            nx, ny = -(y1 - y0), (x1 - x0)
            L = math.hypot(nx, ny)
            if L < 1e-18:
                continue
            nx, ny = nx / L, ny / L
            pa = [nx * q[0] + ny * q[1] for q in A]
            pb = [nx * q[0] + ny * q[1] for q in B]
            if max(pa) <= min(pb) + eps or max(pb) <= min(pa) + eps:
                return False
    return True


def tri_tri_intersect(T1, T2, eps):
    """Returns 'pierce', 'coplanar', or None.

    Plane distances are divided by the triangle normal's length, so `eps` is a
    distance in mm and means the same thing for a 5e-3 mm sliver as for an
    80 mm face. Without that division the test is not even symmetric: a sliver
    has a tiny unnormalised normal, so every distance measured against ITS
    plane is tiny and gets zeroed, while the same pair measured against the big
    triangle's plane is not. On the tape fixture that made pair (21845, 22092)
    read 'coplanar' one way round and None the other, and which answer you got
    depended on the order the broad phase happened to visit the pair in. Both
    the hash here and the BVH in NSO_Repair.js visit pairs unordered, so the
    two disagreed on that one pair (7 coplanar against 6) until this was fixed.
    The interval arithmetic below is unaffected -- it uses only ratios of
    distances, and the normalisation cancels.
    """
    V0, V1, V2 = T1
    U0, U1, U2 = T2

    N1 = cross(sub(V1, V0), sub(V2, V0))
    L1 = norm(N1)
    N2 = cross(sub(U1, U0), sub(U2, U0))
    L2 = norm(N2)
    if L1 <= 0.0 or L2 <= 0.0:
        return None                                  # degenerate, counted apart

    d1 = -dot(N1, V0)
    du0, du1, du2 = ((dot(N1, U0) + d1) / L1, (dot(N1, U1) + d1) / L1,
                     (dot(N1, U2) + d1) / L1)
    if abs(du0) < eps: du0 = 0.0
    if abs(du1) < eps: du1 = 0.0
    if abs(du2) < eps: du2 = 0.0
    du0du1, du0du2 = du0 * du1, du0 * du2
    if du0du1 > 0.0 and du0du2 > 0.0:
        return None                                  # tri2 entirely one side

    d2 = -dot(N2, U0)
    dv0, dv1, dv2 = ((dot(N2, V0) + d2) / L2, (dot(N2, V1) + d2) / L2,
                     (dot(N2, V2) + d2) / L2)
    if abs(dv0) < eps: dv0 = 0.0
    if abs(dv1) < eps: dv1 = 0.0
    if abs(dv2) < eps: dv2 = 0.0
    dv0dv1, dv0dv2 = dv0 * dv1, dv0 * dv2
    if dv0dv1 > 0.0 and dv0dv2 > 0.0:
        return None                                  # tri1 entirely one side

    # |N1 x N2| / (|N1||N2|) is the sine of the angle between the planes, so
    # this cutoff is an angle and not a size, same reasoning as above.
    D = cross(N1, N2)
    axis = max(range(3), key=lambda i: abs(D[i]))
    if abs(D[axis]) / (L1 * L2) < 1e-20:
        # Parallel planes. Only the same plane can overlap, and only then if
        # the two triangles actually share area -- being coplanar is not by
        # itself a defect, so it must be tested, not assumed.
        if abs(dv0) > eps or abs(dv1) > eps or abs(dv2) > eps:
            return None
        return "coplanar" if _coplanar_overlap(T1, T2, N1, eps) else None

    i1 = _intervals(V0[axis], V1[axis], V2[axis], dv0, dv1, dv2, dv0dv1, dv0dv2)
    i2 = _intervals(U0[axis], U1[axis], U2[axis], du0, du1, du2, du0du1, du0du2)
    if i1 is None or i2 is None:
        return "coplanar" if _coplanar_overlap(T1, T2, N1, eps) else None

    # Touching exactly at an interval endpoint is contact, not penetration.
    if i1[1] <= i2[0] + eps or i2[1] <= i1[0] + eps:
        return None
    return "pierce"


def self_intersections(tris, index, eps, max_report, verts=None):
    """Spatial-hash broad phase + Moller narrow phase, skipping adjacent pairs.

    Geometry under test is the WELDED mesh (pass `verts`), not the raw soup.
    Using the weld to decide adjacency but the raw coordinates to decide
    intersection is incoherent -- it calls two vertices the same vertex for the
    skip test and different points for the overlap test -- and it reports every
    sub-tolerance wobble the weld just repaired. On the tape fixture at weld
    1e-4 the raw soup scores 3,073 piercing pairs and the welded mesh 187; the
    2,886 difference is entirely hairline gaps narrower than the weld radius.
    Pass verts=None to score the raw soup instead (--selfint-raw).
    """
    if verts is not None:
        tris = [(verts[i], verts[j], verts[k]) for i, j, k in index]
    n = len(tris)
    if n == 0:
        return {"pairs_tested": 0, "pierce": 0, "coplanar": 0, "examples": [],
                "adjacent_pairs_skipped": 0}

    # Cell size = mean triangle bounding-box diagonal, so a triangle spans
    # only a handful of cells regardless of mesh scale.
    diag_sum, boxes = 0.0, []
    for a, b, c in tris:
        lo = (min(a[0], b[0], c[0]), min(a[1], b[1], c[1]), min(a[2], b[2], c[2]))
        hi = (max(a[0], b[0], c[0]), max(a[1], b[1], c[1]), max(a[2], b[2], c[2]))
        boxes.append((lo, hi))
        diag_sum += norm(sub(hi, lo))
    cell = max(diag_sum / n, 1e-9)

    grid = defaultdict(list)
    for t, (lo, hi) in enumerate(boxes):
        for ix in range(int(math.floor(lo[0] / cell)), int(math.floor(hi[0] / cell)) + 1):
            for iy in range(int(math.floor(lo[1] / cell)), int(math.floor(hi[1] / cell)) + 1):
                for iz in range(int(math.floor(lo[2] / cell)), int(math.floor(hi[2] / cell)) + 1):
                    grid[(ix, iy, iz)].append(t)

    vsets = [set(row) for row in index]
    seen = set()
    pierce, coplanar, adjacent, tested = 0, 0, 0, 0
    examples = []

    for bucket in grid.values():
        m = len(bucket)
        for bi in range(m):
            for bj in range(bi + 1, m):
                a, b = bucket[bi], bucket[bj]
                key = (a, b) if a < b else (b, a)
                if key in seen:
                    continue
                seen.add(key)
                if vsets[a] & vsets[b]:
                    adjacent += 1
                    continue
                la, ha = boxes[a]
                lb, hb = boxes[b]
                if (ha[0] < lb[0] - eps or hb[0] < la[0] - eps or
                        ha[1] < lb[1] - eps or hb[1] < la[1] - eps or
                        ha[2] < lb[2] - eps or hb[2] < la[2] - eps):
                    continue
                tested += 1
                hit = tri_tri_intersect(tris[a], tris[b], eps)
                if hit == "pierce":
                    pierce += 1
                    if len(examples) < max_report:
                        examples.append({"a": a, "b": b, "kind": "pierce"})
                elif hit == "coplanar":
                    coplanar += 1
                    if len(examples) < max_report:
                        examples.append({"a": a, "b": b, "kind": "coplanar"})

    return {"pairs_tested": tested, "pierce": pierce, "coplanar": coplanar,
            "adjacent_pairs_skipped": adjacent, "examples": examples}


# ----------------------------------------------------------------------- main

def validate(path: Path, weld_tol: float, sliver_aspect: float,
             do_selfint: bool, eps: float, selfint_raw: bool = False):
    tris = parse_stl(path)
    verts, index = weld(tris, weld_tol)

    degen, slivers, area = 0, 0, 0.0
    worst_aspect = 0.0
    for a, b, c in tris:
        ar = tri_area(a, b, c)
        area += ar
        if ar < 1e-12:
            degen += 1
            continue
        asp = aspect_ratio(a, b, c)
        if asp > worst_aspect:
            worst_aspect = asp
        if asp > sliver_aspect:
            slivers += 1

    lo = [min(p[i] for t in tris for p in t) for i in range(3)] if tris else [0, 0, 0]
    hi = [max(p[i] for t in tris for p in t) for i in range(3)] if tris else [0, 0, 0]

    out = {
        "file": str(path),
        "triangles": len(tris),
        "welded_vertices": len(verts),
        "weld_tol": weld_tol,
        "bbox_min": [round(v, 6) for v in lo],
        "bbox_max": [round(v, 6) for v in hi],
        "bbox_size": [round(hi[i] - lo[i], 6) for i in range(3)],
        "signed_volume": signed_volume(tris),
        "surface_area": area,
        "degenerate_tris": degen,
        "sliver_tris": slivers,
        "sliver_aspect_threshold": sliver_aspect,
        "worst_aspect_ratio": worst_aspect,
    }
    out.update(edge_report(index))
    # Euler characteristic V - E + F; a closed genus-0 solid gives 2.
    out["euler_characteristic"] = len(verts) - out["unique_edges"] + len(tris)
    if do_selfint:
        out["self_intersection"] = self_intersections(
            tris, index, eps, 8, None if selfint_raw else verts)
        out["self_intersection"]["geometry"] = "raw" if selfint_raw else "welded"
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("stl")
    ap.add_argument("--weld", type=float, default=WELD_TOL)
    ap.add_argument("--sliver-aspect", type=float, default=100.0)
    ap.add_argument("--eps", type=float, default=SELFINT_EPS)
    ap.add_argument("--no-selfint", action="store_true")
    ap.add_argument("--selfint-raw", action="store_true",
                    help="score self-intersection on the raw soup instead of "
                         "the welded mesh (pre-consolidation behaviour)")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    path = Path(args.stl)
    if not path.exists():
        print("missing file", path, file=sys.stderr)
        return 2

    r = validate(path, args.weld, args.sliver_aspect, not args.no_selfint,
                 args.eps, args.selfint_raw)
    if args.json:
        print(json.dumps(r, indent=2))
        return 0

    print(f"file                      {r['file']}")
    print(f"triangles                 {r['triangles']}")
    print(f"welded_vertices           {r['welded_vertices']}  (tol {r['weld_tol']})")
    print(f"bbox_size                 {r['bbox_size']}")
    print(f"signed_volume             {r['signed_volume']:.6f} mm^3")
    print(f"surface_area              {r['surface_area']:.6f} mm^2")
    print(f"unique_edges              {r['unique_edges']}")
    print(f"open_edges                {r['open_edges']}")
    print(f"nonmanifold_edges         {r['nonmanifold_edges']}")
    print(f"odd_edges                 {r['odd_edges']}")
    print(f"inconsistent_winding      {r['inconsistent_winding_edges']}")
    print(f"euler_characteristic      {r['euler_characteristic']}")
    print(f"degenerate_tris           {r['degenerate_tris']}")
    print(f"sliver_tris(aspect>{r['sliver_aspect_threshold']:g})  {r['sliver_tris']}")
    print(f"worst_aspect_ratio        {r['worst_aspect_ratio']:.3f}")
    si = r.get("self_intersection")
    if si:
        print(f"selfint_geometry          {si['geometry']}")
        print(f"selfint_pairs_tested      {si['pairs_tested']}")
        print(f"selfint_adjacent_skipped  {si['adjacent_pairs_skipped']}")
        print(f"selfint_piercing          {si['pierce']}")
        print(f"selfint_coplanar          {si['coplanar']}")
        for ex in si["examples"]:
            print(f"  example {ex['kind']}: tri {ex['a']} vs tri {ex['b']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
