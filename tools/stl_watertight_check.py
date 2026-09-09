#!/usr/bin/env python3
"""Cheap watertight / degeneracy check for ASCII or binary STL.

Usage:
  python3 tools/stl_watertight_check.py path/to/file.stl [--odd] [--degen]

--odd    treat any undirected edge with count != 2 as a failure (open or non-manifold)
--degen  fail on zero-area triangles
Exit 0 if clean under the requested flags, 1 otherwise.
"""
from __future__ import annotations

import argparse
import struct
import sys
from collections import defaultdict
from pathlib import Path


def parse_stl(path: Path):
    data = path.read_bytes()
    if data[:5].lower() == b"solid" and b"facet" in data[:200].lower():
        return parse_ascii(data.decode("utf-8", errors="replace"))
    return parse_binary(data)


def parse_ascii(text: str):
    tris = []
    verts = []
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
    tris = []
    off = 84
    for _ in range(n):
        if off + 50 > len(data):
            break
        vals = struct.unpack_from("<12fH", data, off)
        a = vals[3:6]
        b = vals[6:9]
        c = vals[9:12]
        tris.append((a, b, c))
        off += 50
    return tris


def q(p, nd=5):
    return (round(p[0], nd), round(p[1], nd), round(p[2], nd))


def area2(a, b, c):
    ux, uy, uz = b[0] - a[0], b[1] - a[1], b[2] - a[2]
    vx, vy, vz = c[0] - a[0], c[1] - a[1], c[2] - a[2]
    nx = uy * vz - uz * vy
    ny = uz * vx - ux * vz
    nz = ux * vy - uy * vx
    return (nx * nx + ny * ny + nz * nz) ** 0.5 * 0.5


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("stl")
    ap.add_argument("--odd", action="store_true")
    ap.add_argument("--degen", action="store_true")
    args = ap.parse_args()
    path = Path(args.stl)
    if not path.exists():
        print("missing file", path, file=sys.stderr)
        return 1
    tris = parse_stl(path)
    print("tris", len(tris))
    edges = defaultdict(int)
    degen = 0
    for a, b, c in tris:
        if area2(a, b, c) < 1e-12:
            degen += 1
        for u, v in ((a, b), (b, c), (c, a)):
            e = tuple(sorted((q(u), q(v))))
            edges[e] += 1
    odd = sum(1 for k, n in edges.items() if n != 2)
    ones = sum(1 for n in edges.values() if n == 1)
    multi = sum(1 for n in edges.values() if n > 2)
    print("unique_edges", len(edges))
    print("open_edges(count=1)", ones)
    print("nonmanifold_edges(count>2)", multi)
    print("odd_edges(count!=2)", odd)
    print("degenerate_tris", degen)
    fail = False
    if args.odd and odd:
        print("FAIL odd edges")
        fail = True
    if args.degen and degen:
        print("FAIL degenerate tris")
        fail = True
    if not fail:
        print("OK")
    return 1 if fail else 0


if __name__ == "__main__":
    sys.exit(main())
