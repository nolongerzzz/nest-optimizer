# Thingi10K fixtures for NSO_Repair

Three real meshes, part of the regression suite. All three are committed here
and all three are **measured** — every expectation in
`tools/nso_repair_regress.js` was produced by running this module on these
files, not transcribed from anywhere.

| file | tris | defect | result |
|---|---|---|---|
| `40921.stl` | 186 | two shells meeting at 17 bowtie vertices | repaired — shells separated |
| `37825.stl` | 162 | one sheet touching itself along a 4-use edge | declines — out of scope |
| `39644.stl` | 290 | closed solid with an internal partition wall (4 three-use edges) | declines — gate blocks |

```sh
node tools/nso_repair_regress.js
```

## 40921 is not a clean baseline

It was specified as one, and the repo's own `tools/stl_watertight_check.py`
agrees — it reports `OK`, 0 odd edges. That check counts edges, and **an edge
count cannot see a vertex pinch.**

The arithmetic settles it. Euler characteristic `V - E + F` for this file is
`80 - 279 + 186 = -13`. An odd characteristic is impossible for any closed
orientable surface. Splitting the 17 bowtie vertices gives `97 - 279 + 186 = 4`
— exactly two spheres — and takes self-intersections from 5 to 0.

So 40921 is two shells joined at 17 points, and repairing it is correct. The
suite asserts the characteristic on both sides, so the argument itself is
regression-gated. It also asserts the repair settles: a second pass finds
nothing.

The one cost is geometric. Each of the 34 vertex copies is nudged off the
contact point, which moves volume by 0.19% (9551.05 -> 9371.58). That is the
price of separating the shells, not an error.

## 37825 and 39644 both decline

Both are non-manifold *edge* cases, and both are stopped by the odd-edge gate
rather than repaired. Details and the reasoning in `docs/NSO_Repair.md`.

One difference from the original specification worth flagging: 39644 was
expected to be stopped by the **self-intersection** gate, at 0 -> 9. It is
stopped by the **odd-edge** gate instead, at 4 -> 8, because detaching the
internal wall opens boundary rather than crossing anything. The outcome the
ticket asked for — gate blocks, file left unchanged — holds exactly; the
mechanism is not the one named.
