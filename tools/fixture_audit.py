#!/usr/bin/env python3
"""Fixture / library integrity audit: every .stl under fixtures/ and library/.

    python3 tools/fixture_audit.py                 # table, exit 0
    python3 tools/fixture_audit.py --gate          # exit 1 on any FORMAT failure
    python3 tools/fixture_audit.py --json          # one JSON document
    python3 tools/fixture_audit.py --root /path    # another checkout (e.g. main)
    python3 tools/fixture_audit.py --no-selfint    # skip the O(n log n) pair test

Three checks per file, in this order:

  1. FORMAT - can the bytes be what they claim? For a binary STL the declared
     triangle count must give exactly the file length (84 + 50 n), n must be
     > 0, and the body must not be printable text (a Contents-API upload that
     wrote a placeholder or base64 instead of bytes looks exactly like that).
     For an ASCII STL there must be facets and every facet three vertices.
     This is the check tools/mesh_validate.py cannot do: its binary reader
     stops quietly at the end of a short file, so a truncated fixture reads
     as a smaller, still-plausible mesh. library/CTH_fixture.stl was ASCII
     while a test read it as binary; that class of fault is caught here.

  2. CANONICAL - tools/mesh_validate.py's own validate(): open / non-manifold
     / inconsistent-winding edges, degenerates, piercing and coplanar pairs,
     the verdict. Same policy, same code, imported rather than copied.

  3. EULER - V - E + F as mesh_validate computes it. A closed surface (0 open,
     0 non-manifold edges) must have an EVEN characteristic; an odd one means
     a vertex pinch that no edge count can see - the 40921 bowtie case, which
     stl_watertight_check.py passed. Reported as PINCH.

Only FORMAT gates: fixtures/repair/ and fixtures/open/ hold meshes that are
defective on purpose, so CANONICAL and EULER are reported per file for the
reader to judge, never failed. A mesh that fails CANONICAL is not a bad
fixture; a file that fails FORMAT always is.
"""
from __future__ import annotations

import argparse
import json
import struct
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import mesh_validate as mv  # noqa: E402

ROOTS = ("fixtures", "library")


def format_check(path: Path) -> dict:
    data = path.read_bytes()
    r = {"bytes": len(data), "problems": []}
    if data[:5].lower() == b"solid" and b"facet" in data[:300].lower():
        r["format"] = "ascii"
        text = data.decode("utf-8", errors="replace")
        facets = text.count("endfacet")
        verts = sum(1 for ln in text.splitlines() if ln.strip().startswith("vertex "))
        r["declared"] = facets
        if facets == 0:
            r["problems"].append("ascii STL with no facets")
        elif verts != 3 * facets:
            r["problems"].append(f"{facets} facets but {verts} vertex lines")
        return r

    r["format"] = "binary"
    if len(data) < 84:
        r["declared"] = None
        r["problems"].append(f"{len(data)} bytes, shorter than the 84-byte header")
        return r
    n = struct.unpack_from("<I", data, 80)[0]
    expected = 84 + 50 * n
    r["declared"] = n
    r["expected_bytes"] = expected
    if n == 0:
        r["problems"].append("declares 0 triangles")
    if expected != len(data):
        r["problems"].append(f"declares {n} triangles = {expected} bytes, file is {len(data)}")
    head = data[:512]
    printable = sum(1 for b in head if 32 <= b < 127 or b in (9, 10, 13))
    if head and printable / len(head) > 0.95:
        r["problems"].append("first 512 bytes are all printable text - a placeholder, not a mesh")
    return r


def audit_file(path: Path, rel: str, selfint: bool) -> dict:
    row = {"file": rel}
    row.update(format_check(path))
    row["format_ok"] = not row["problems"]
    try:
        v = mv.validate(path, mv.WELD_TOL, 100.0, selfint, mv.SELFINT_EPS,
                        False, False, 0.0, mv.WALL_PROBE)
    except Exception as e:  # a file the checker cannot read is a FORMAT fault too
        row["problems"].append(f"mesh_validate raised {type(e).__name__}: {e}")
        row["format_ok"] = False
        return row
    row["triangles"] = v["triangles"]
    if row["format_ok"] and row.get("declared") not in (None, v["triangles"]):
        row["problems"].append(f"parser read {v['triangles']} triangles, header says {row['declared']}")
        row["format_ok"] = False
    row["open_edges"] = v["open_edges"]
    row["nonmanifold_edges"] = v["nonmanifold_edges"]
    row["inconsistent_winding_edges"] = v["inconsistent_winding_edges"]
    row["degenerate_tris"] = v["degenerate_tris"]
    row["euler"] = v["euler_characteristic"]
    row["closed"] = v["open_edges"] == 0 and v["nonmanifold_edges"] == 0
    row["pinch"] = row["closed"] and (v["euler_characteristic"] % 2 != 0)
    si = v.get("self_intersection") or {}
    row["pierce"] = si.get("pierce")
    row["coplanar"] = si.get("coplanar")
    row["verdict"] = v["verdict"]
    row["verdict_fails"] = v["verdict_fails"]
    return row


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--root", default=str(Path(__file__).resolve().parent.parent))
    ap.add_argument("--gate", action="store_true", help="exit 1 if any file fails FORMAT")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--no-selfint", action="store_true")
    args = ap.parse_args()

    root = Path(args.root).resolve()
    files = []
    for d in ROOTS:
        base = root / d
        if base.is_dir():
            files += sorted(p for p in base.rglob("*.stl") if p.is_file())
    rows = [audit_file(p, str(p.relative_to(root)), not args.no_selfint) for p in files]

    if args.json:
        print(json.dumps({"root": str(root), "files": rows}, indent=1))
    else:
        w = max((len(r["file"]) for r in rows), default=20)
        print(f"{'file':<{w}}  fmt     bytes   tris  FORMAT  open  nonmf  wind  euler  pierce  copl  verdict")
        for r in rows:
            tag = "ok" if r["format_ok"] else "FAIL"
            if r["format_ok"] and r.get("pinch"):
                tag = "PINCH"
            print(f"{r['file']:<{w}}  {r['format']:<6} {r['bytes']:>8} {r.get('triangles', 0):>6}  "
                  f"{tag:<6}  {r.get('open_edges', '-'):>4}  {r.get('nonmanifold_edges', '-'):>5}  "
                  f"{r.get('inconsistent_winding_edges', '-'):>4}  {r.get('euler', '-'):>5}  "
                  f"{('-' if r.get('pierce') is None else r['pierce']):>6}  "
                  f"{('-' if r.get('coplanar') is None else r['coplanar']):>4}  {r.get('verdict', '-')}")
            for p in r["problems"]:
                print(f"{'':<{w}}    ! {p}")

    fmt_fail = [r for r in rows if not r["format_ok"]]
    pinch = [r for r in rows if r.get("pinch")]
    geo_fail = [r for r in rows if r.get("verdict") == "FAIL"]
    if not args.json:
        print(f"\n{len(rows)} files under {', '.join(ROOTS)} in {root}")
        print(f"  FORMAT failures : {len(fmt_fail)}" + (" - " + ", ".join(r['file'] for r in fmt_fail) if fmt_fail else ""))
        print(f"  PINCH (closed by edge count, odd Euler): {len(pinch)}" + (" - " + ", ".join(r['file'] for r in pinch) if pinch else ""))
        print(f"  canonical verdict FAIL: {len(geo_fail)} (reported, not gated - see the docstring)")
    return 1 if (args.gate and fmt_fail) else 0


if __name__ == "__main__":
    sys.exit(main())
