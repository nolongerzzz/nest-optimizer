Test meshes for Claude / Grok. Not shipped to Pages as product files.

- box-20mm.stl — closed 20 mm cube, origin-centered, Z-up, 12 triangles.
  Soften gate: one Square split, then Corners / Round / Bevel at R=0.5. Lid must stay on the cut plane.

## Hinge and strap fixtures: real boolean unions since 2026-09-16

`hinge_knuckle_box.stl`, `hinge_knuckle_lid.stl`, `hinge_pip.stl` and
`lid_strap.stl` (identical copies in `library/`) were first written by an
early generator that concatenated closed shells with deliberate overlap. That
slices correctly (a slicer union-fills the overlap) but every overlap was a
real piercing pair, so Join / Subtract could not be run on them cleanly.

They are now the real boolean union of those shells, produced by
`tools/nso_fixture_union.mjs` through the same Manifold kernel `app-join.js`
ships. Measured with `tools/mesh_validate.py` (0 piercing, 0 coplanar, 0 open,
0 non-manifold on every one):

| file | tris before → after | shells → bodies | volume before (double-counted) → after |
|------|--------------------|-----------------|-----------------------------------------|
| hinge_knuckle_box | 780 → 730 | 4 → 1 (genus 3) | 741.084 → 636.096 mm³ |
| hinge_knuckle_lid | 524 → 460 | 3 → 1 (genus 2) | 526.056 → 456.064 mm³ |
| hinge_pip | 1468 → 1528 | 11 → 6 (5 knuckle units + the free pin) | 1295.343 → 1235.684 mm³ |
| lid_strap | 24 → 28 | 2 → 1 | 6120.000 → 6048.000 mm³ |

The "after" volume equals sum-of-shells minus pairwise overlap on each file,
so nothing overlapped three deep and nothing was lost. Bounding boxes are
unchanged and cross-section areas at five heights match the union-filled
originals to 3e-7 mm², so they slice exactly as before. `hinge_pip` stays a
multi-body file on purpose: the pin has clearance inside the knuckles.

`library/box_closed.stl` is NOT regenerated; see `library/README.md`.
