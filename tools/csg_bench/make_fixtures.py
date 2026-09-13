#!/usr/bin/env python3
"""Generate the curved / organic fixtures the CSG stress test needs.

The repo's fixtures are all analytic-shell output (boxes, prisms, tubes) --
exactly the class NSO already handles without booleans. These three are the
class it does not:

  fixture_sphere_curved.stl   doubly-curved, every face a different normal
  fixture_groove_concave.stl  a torus: concave surface AND genus 1
  fixture_blob_organic.stl    a displaced icosphere -- no closed-form
                              parametric description, the scanned-geometry proxy

All are closed, outward-wound, free of degenerate triangles.
"""
import math
import struct
import sys
from pathlib import Path


def write_stl(path, tris, header=b"nso fixture"):
    with open(path, "wb") as f:
        f.write(header.ljust(80, b"\0"))
        f.write(struct.pack("<I", len(tris)))
        for a, b, c in tris:
            ux, uy, uz = b[0]-a[0], b[1]-a[1], b[2]-a[2]
            vx, vy, vz = c[0]-a[0], c[1]-a[1], c[2]-a[2]
            nx, ny, nz = uy*vz-uz*vy, uz*vx-ux*vz, ux*vy-uy*vx
            L = math.sqrt(nx*nx+ny*ny+nz*nz) or 1.0
            f.write(struct.pack("<12fH", nx/L, ny/L, nz/L, *a, *b, *c, 0))
    return len(tris)


def uv_sphere(radius, nu=48, nv=24):
    """Outward-wound UV sphere. Poles are fans, so no zero-area triangles."""
    def P(i, j):
        theta = math.pi * j / nv
        phi = 2.0 * math.pi * i / nu
        return (radius * math.sin(theta) * math.cos(phi),
                radius * math.sin(theta) * math.sin(phi),
                radius * math.cos(theta))
    tris = []
    top, bot = (0.0, 0.0, radius), (0.0, 0.0, -radius)
    for i in range(nu):
        i2 = (i + 1) % nu
        tris.append((top, P(i, 1), P(i2, 1)))
        tris.append((bot, P(i2, nv - 1), P(i, nv - 1)))
        for j in range(1, nv - 1):
            a, b, c, d = P(i, j), P(i2, j), P(i2, j + 1), P(i, j + 1)
            tris.append((a, d, c))
            tris.append((a, c, b))
    return tris


def torus(R, r, nu=64, nv=32):
    """Outward-wound torus. Genus 1 and concave over the inner half."""
    def P(i, j):
        u = 2.0 * math.pi * i / nu
        v = 2.0 * math.pi * j / nv
        return ((R + r * math.cos(v)) * math.cos(u),
                (R + r * math.cos(v)) * math.sin(u),
                r * math.sin(v))
    tris = []
    for i in range(nu):
        i2 = (i + 1) % nu
        for j in range(nv):
            j2 = (j + 1) % nv
            a, b, c, d = P(i, j), P(i2, j), P(i2, j2), P(i, j2)
            tris.append((a, b, c))
            tris.append((a, c, d))
    return tris


def icosphere(radius, subdiv):
    t = (1.0 + math.sqrt(5.0)) / 2.0
    verts = [(-1, t, 0), (1, t, 0), (-1, -t, 0), (1, -t, 0),
             (0, -1, t), (0, 1, t), (0, -1, -t), (0, 1, -t),
             (t, 0, -1), (t, 0, 1), (-t, 0, -1), (-t, 0, 1)]
    faces = [(0,11,5),(0,5,1),(0,1,7),(0,7,10),(0,10,11),
             (1,5,9),(5,11,4),(11,10,2),(10,7,6),(7,1,8),
             (3,9,4),(3,4,2),(3,2,6),(3,6,8),(3,8,9),
             (4,9,5),(2,4,11),(6,2,10),(8,6,7),(9,8,1)]
    verts = [list(v) for v in verts]
    cache = {}

    def mid(a, b):
        key = (min(a, b), max(a, b))
        if key in cache:
            return cache[key]
        p = [(verts[a][k] + verts[b][k]) / 2.0 for k in range(3)]
        verts.append(p)
        cache[key] = len(verts) - 1
        return len(verts) - 1

    for _ in range(subdiv):
        nf = []
        for a, b, c in faces:
            ab, bc, ca = mid(a, b), mid(b, c), mid(c, a)
            nf += [(a, ab, ca), (b, bc, ab), (c, ca, bc), (ab, bc, ca)]
        faces = nf

    out = []
    for v in verts:
        L = math.sqrt(sum(x * x for x in v)) or 1.0
        out.append([x / L * radius for x in v])
    return out, faces


def blob(radius, subdiv=4):
    """Icosphere pushed around by three incommensurate sine bands.

    Smooth and closed, but there is no primitive, revolve or extrusion that
    reproduces it -- which is the whole point: this is the shape class the
    analytic-shell path cannot build.
    """
    verts, faces = icosphere(radius, subdiv)
    out = []
    for x, y, z in verts:
        L = math.sqrt(x*x + y*y + z*z) or 1.0
        nx, ny, nz = x/L, y/L, z/L
        d = (1.0
             + 0.22 * math.sin(3.0 * nx + 1.7)
             + 0.15 * math.sin(4.0 * ny * nz - 0.4)
             + 0.09 * math.sin(7.0 * nz + 2.3) * math.cos(5.0 * nx))
        out.append((nx * radius * d, ny * radius * d, nz * radius * d))
    return [(out[a], out[b], out[c]) for a, b, c in faces]


def main():
    d = Path(sys.argv[1] if len(sys.argv) > 1 else "fixtures")
    d.mkdir(parents=True, exist_ok=True)
    for name, tris in (
        ("fixture_sphere_curved.stl", uv_sphere(10.0, 48, 24)),
        ("fixture_groove_concave.stl", torus(12.0, 4.0, 64, 32)),
        ("fixture_blob_organic.stl", blob(12.0, 4)),
    ):
        n = write_stl(d / name, tris)
        print(f"{name:32s} {n} tris")


if __name__ == "__main__":
    main()
