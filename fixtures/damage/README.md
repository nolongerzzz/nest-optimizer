# Damaged-on-purpose fixtures

Each file is a clean `fixtures/quick/` piece with **one** controlled defect,
injected by `tools/nso_damage.js` (see `docs/DAMAGE.md`). They follow PR #82's
convention: the name is `<clean>_<defect>.stl`, the STL header starts with
`NSO damage fixture:`, and every file is generated rather than hand-made.

```sh
node tools/nso_damage_make_fixtures.js           # rewrite them (and the nest-library copies, given a checkout)
node tools/nso_damage_make_fixtures.js --check   # byte-diff against the tree
node tools/nso_damage_test.js                    # hold every file to damage.json via the checker
```

`damage.json` records each file's source, parameters and seed. It also records
`expected`, the exact numbers `tools/mesh_validate.py --json` must report.

| file | tris | defect | open | NM | winding | χ | Library |
|---|---|---|---|---|---|---|---|
| `shape-sphere_hole.stl` | 1979 | one small hole, 5 faces, 1 loop | 7 | 0 | 0 | 1 | yes |
| `shape-sphere_holes-shredded.stl` | 1015 | 12 sites grown together: 969 faces gone, 2 loops | 221 | 0 | 0 | −3 | yes |
| `shape-sphere_hole-painted.stl` | 1976 | faces 0–7 removed as a painted selection | 10 | 0 | 0 | 1 | |
| `shape-cylinder_holes-light.stl` | 118 | 4 sites, 10 faces, 2 loops: one pinched at the cap centre, one folded over the top rim onto the wall (Solidify regression, driver-testing round 1) | 16 | 0 | 0 | −1 | |
| `shape-tube_severed.stl` | 260 | one 1 mm slot through the ring wall, capped: a C, genus 1 → 0 | 0 | 0 | 0 | 2 | yes |
| `shape-tube_severed-apart.stl` | 264 | two slots: two bodies | 0 | 0 | 0 | 4 | |
| `shape-sphere_nm-duplicate.stl` | 1985 | one face duplicated in place | 0 | 3 | 3 | 3 | yes |
| `shape-sphere_nm-duplicate-flipped.stl` | 2052 | 5 patches (68 faces) duplicated, reversed | 0 | 132 | 204 | 70 | |
| `shape-sphere_winding-flip.stl` | 1984 | one face flipped, nothing added or removed | 0 | 0 | 3 | 2 | yes |
| `shape-torus_weld-collide.stl` | 2050 | a vertex 5e-5 mm from a distinct neighbour | 0 | 2 | 5 | 1 | yes |
| `shape-torus_weld-near.stl` | 2050 | the same split at 2e-4 mm: the clean control | 0 | 0 | 0 | 0 | |
| `shape-torus_weld-shredded.stl` | 2112 | 32 weld collisions | 0 | 64 | 160 | 32 | |

Every file has 0 degenerate triangles and 0 piercing pairs. The severed
tubes pass the checker outright, because that is the point of them: see
`docs/DAMAGE.md`, "The damage types and the bugs they model".
